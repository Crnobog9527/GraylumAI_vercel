/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe (Master Plan v12 AC-0 items 2-6). Standalone script run by
// hand; application code must never import it. Dry run unless --live.
import {appendFileSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBudget, HARD_MAX_CALLS, HARD_MAX_USD, memoryLedger, nanoToUsd, usdToNano, type LedgerStore} from './budget.ts';
import {syntheticUpstream} from './dryRun.ts';
import {acquireLedgerLock, fileLedger, recordExternalUsage} from './ledger.ts';
import {accountHome, assertOutsideRepository, realPath} from './paths.ts';
import {buildPlan, describePlan, parseProbeArgs, TRIAL_KINDS, USAGE, type ProbePlan} from './plan.ts';
import {loadScenarios, loadSkill, scenariosOf} from './skill.ts';
import {summarize, summaryMarkdown} from './summary.ts';
import {runTrial, type TrialResult} from './trial.ts';
import type {Upstream} from './transport.ts';

export const KEY_ENV = 'AC0_OPENROUTER_API_KEY';
/** Statuses that mean every further call with this key would fail too. */
const RUN_FATAL_STATUSES = new Set([401, 402, 403]);

export type ProbeDeps = {
  /** Network used only with --live. Tests pass a mock; a dry run never uses it. */
  fetch?: Upstream;
  /** Test-only home directory. Real runs use accountHome(), never HOME. */
  home?: string;
  /** Test-only ledger location. There is no command-line or environment override. */
  ledgerPath?: string;
  clock?: () => number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

export {assertOutsideRepository};

export function redactor(secrets: string[]) {
  const values = secrets.filter(secret => secret.length >= 8);
  return (text: string): string => values.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
}

function readKey(env: Record<string, string | undefined>): string {
  const key = env[KEY_ENV]?.trim() ?? '';
  if (!key || /\s/.test(key)) throw new Error(`PROBE_KEY_MISSING: set ${KEY_ENV} (the capped probe key) in the environment`);
  return key;
}

/** Results hold model output derived from the private Skill: owner-only access.
 * A live run refuses an existing directory that others can read and never
 * changes permissions on a directory it did not create. */
function privateDirectory(dir: string, live: boolean): string {
  mkdirSync(dir, {recursive: true, mode: 0o700});
  if (live && (statSync(dir).mode & 0o077) !== 0) {
    throw new Error(`PROBE_OUTPUT_DIR_NOT_PRIVATE: ${dir} is accessible to other users; restrict it to its owner or choose another --out-dir`);
  }
  return dir;
}

export type ProbeOutcome = {exitCode: number; runDir?: string; plan?: ProbePlan; results?: TrialResult[]; stop?: string};

export async function runProbe(argv: string[], env: Record<string, string | undefined>, deps: ProbeDeps = {}): Promise<ProbeOutcome> {
  const stdout = deps.stdout ?? (text => process.stdout.write(text));
  const stderr = deps.stderr ?? (text => process.stderr.write(text));
  const clock = deps.clock ?? (() => performance.now());
  let redact = redactor([]);
  let releaseLock = () => {};
  try {
    const parsed = parseProbeArgs(argv, deps.home ?? accountHome());
    const args = deps.ledgerPath ? {...parsed, ledger: deps.ledgerPath} : parsed;
    if (args.help) {
      stdout(USAGE);
      return {exitCode: 0};
    }
    if (args.external) {
      assertOutsideRepository(args.ledger, 'ledger');
      releaseLock = acquireLedgerLock(realPath(args.ledger));
      const totals = recordExternalUsage(realPath(args.ledger), args.external);
      stdout(`Recorded external usage: ${args.external.calls} calls, $${args.external.usd}. ` +
        `Ledger now ${totals.calls} calls, $${nanoToUsd(totals.nanoUsd).toFixed(6)} of 200 calls / $3. No request was sent.\n`);
      return {exitCode: 0};
    }
    assertOutsideRepository(args.outDir);
    if (args.skillDir) assertOutsideRepository(args.skillDir, 'skill');
    const skill = loadSkill(args.skillDir);
    const {scenarios, digest} = loadScenarios(args.scenarios, skill);
    const plan = buildPlan(args, skill, scenarios, digest);
    const mode = args.live ? 'live' : 'dry-run';
    let ledger: LedgerStore = memoryLedger();
    if (args.live) {
      assertOutsideRepository(args.ledger, 'ledger');
      // Held for the whole run: reservations are read, checked and written under it.
      releaseLock = acquireLedgerLock(realPath(args.ledger));
      ledger = fileLedger(realPath(args.ledger));
    }
    const before = ledger.read();
    const ledgerPath = args.live ? realPath(args.ledger) : undefined;
    stdout(describePlan(plan, mode, {calls: before.calls, usd: nanoToUsd(before.nanoUsd), ...(ledgerPath ? {path: ledgerPath} : {})}));
    let upstream: Upstream;
    let authorization: string;
    if (args.live) {
      if (args.confirm !== plan.planId) {
        throw new Error(`PROBE_CONFIRM_REQUIRED: review the plan above, then rerun with --live --confirm ${plan.planId}`);
      }
      if (before.calls >= HARD_MAX_CALLS || before.nanoUsd >= usdToNano(HARD_MAX_USD)) {
        throw new Error('PROBE_TOTAL_BUDGET_EXHAUSTED: the ledger has reached 200 calls or $3');
      }
      const key = readKey(env);
      redact = redactor([key]);
      if (!deps.fetch && typeof fetch !== 'function') throw new Error('PROBE_FETCH_UNAVAILABLE');
      upstream = deps.fetch ?? ((url, init) => fetch(url, init));
      authorization = 'Bearer ' + key;
    } else {
      upstream = syntheticUpstream([...skill.references.keys()]);
      authorization = 'Bearer dry-run';
    }
    const budget = createBudget({maxCalls: plan.maxCalls, maxUsd: plan.maxUsd, ledger});
    const outDir = privateDirectory(realPath(args.outDir), args.live);
    const runDir = join(outDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + mode + '-' + plan.planId);
    mkdirSync(runDir, {mode: 0o700});
    const write = (name: string, text: string) => writeFileSync(join(runDir, name), redact(text), {mode: 0o600});
    write('plan.json', JSON.stringify({...plan, mode}, null, 2) + '\n');
    const results: TrialResult[] = [];
    const skipped: Array<{configId: string; kind: string; count: number; reason: string}> = [];
    let runStop: string | undefined;
    outer: for (const config of plan.configs) {
      let configStop: string | undefined;
      for (const kind of TRIAL_KINDS) {
        const pool = scenariosOf(scenarios, kind);
        for (let index = 0; index < plan.counts[kind]; index++) {
          if (configStop) {
            skipped.push({configId: config.id, kind, count: plan.counts[kind] - index, reason: configStop});
            break;
          }
          const result = await runTrial({
            kind, scenario: pool[index % pool.length]!, index, config, skill, maxTokens: plan.maxTokens,
            timeoutMs: plan.timeoutMs, budget, upstream, authorization, clock, redact,
          });
          results.push(result);
          appendFileSync(join(runDir, 'results.jsonl'), redact(JSON.stringify(result)) + '\n', {mode: 0o600});
          const label = result.outcome?.category ?? result.stop ?? 'measured';
          const first = result.firstVisibleMs === undefined ? '-' : Math.round(result.firstVisibleMs) + ' ms';
          stdout(`[${config.id}] ${kind} #${index + 1}: ${label}; first visible ${first}; total ${Math.round(result.totalMs)} ms\n`);
          if (result.stop === 'budget') {
            runStop = 'budget:' + (result.budgetStop ?? 'stopped');
            break outer;
          }
          if (result.stop === 'provider_rejected') {
            if (RUN_FATAL_STATUSES.has(result.httpStatus ?? 0)) {
              runStop = 'provider_rejected_http_' + result.httpStatus;
              break outer;
            }
            configStop = 'provider_rejected_http_' + (result.httpStatus ?? 'unknown');
          }
        }
      }
    }
    const rows = summarize(plan.configs, results);
    const calls = results.reduce((sum, result) => sum + result.calls.length, 0);
    const costUsd = nanoToUsd(budget.run.nanoUsd);
    const totals = {mode, calls, costUsd, ...(runStop ? {stop: runStop} : {})};
    const after = ledger.read();
    write('summary.json', JSON.stringify({planId: plan.planId, ...totals, skipped,
      ledgerAfter: args.live ? {calls: after.calls, usd: nanoToUsd(after.nanoUsd)} : undefined, configs: rows}, null, 2) + '\n');
    const markdown = summaryMarkdown(rows, totals);
    write('summary.md', markdown);
    stdout(redact(markdown));
    stdout(`Results: ${runDir}\n`);
    return {exitCode: 0, runDir, plan, results, ...(runStop ? {stop: runStop} : {})};
  } catch (error) {
    stderr(redact(error instanceof Error ? error.message : String(error)) + '\n');
    return {exitCode: 2};
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outcome = await runProbe(process.argv.slice(2), process.env);
  process.exitCode = outcome.exitCode;
}
