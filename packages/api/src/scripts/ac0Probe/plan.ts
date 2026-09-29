/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {AGENT_TURN_CONFIG, agentTurnPrompt} from './agentTurn.ts';
import {DEFAULT_MAX_CALLS, DEFAULT_MAX_USD, HARD_MAX_CALLS, HARD_MAX_USD, validateCaps} from './budget.ts';
import {callBoundUsd, DEFAULT_CONFIG_IDS, resolveConfigs, thinkingLabel, type ProbeConfig} from './config.ts';
import {parsePrivateJson, scenariosOf, stepRules, type LoadedSkill, type Scenario} from './skill.ts';
import type {TrialKind} from './trial.ts';

export const TRIAL_KINDS: readonly TrialKind[] = ['ask', 'text', 'reference'];
/** Worst case provider calls per trial: reference trials may read, read, answer. */
export const CALLS_PER_TRIAL: Record<TrialKind, number> = {ask: 1, text: 1, reference: 3};
/** Same per-response bound as the real path (bill2/openRouterPolicy.ts). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Host rules and tool schemas travel with every request. */
const REQUEST_OVERHEAD_BYTES = 4096;

export const USAGE = `AC-0b model probe (dry run unless --live).

  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON packages/api/src/scripts/ac0Probe/main.ts [options]

  --agent-turn          AC1-4: fixed DeepSeek deepinfra/fp8, thinking off; exactly 30 ask + 10 text, no references
  --skill-dir <dir>     private Skill directory with SKILL.md and references/ (default: synthetic repo fixture)
  --scenarios <file>    scenario JSON; required with --skill-dir (keep it outside the repository)
  --configs <ids>       comma-separated config ids (default: ${DEFAULT_CONFIG_IDS.join(',')})
  --config-file <file>  JSON array of extra configs {id, model, route, effort | reasoning, maxPrice:{prompt, completion}}
  --ask <n>             ask_question trials per config (default 30)
  --text <n>            plain-text streaming trials per config (default 0)
  --reference <n>       reference-first trials per config (default 0)
  --max-calls <n>       provider call cap for this run (default ${DEFAULT_MAX_CALLS}, at most ${HARD_MAX_CALLS})
  --max-usd <x>         spend cap for this run in USD (default ${DEFAULT_MAX_USD}, at most ${HARD_MAX_USD})
  --max-tokens <n>      output tokens per call (default 1024)
  --timeout-ms <n>      per-call deadline (default ${DEFAULT_TIMEOUT_MS})
  --out-dir <dir>       results directory outside the repository (default ~/.graylum/ac0/results)
  --live                send real requests; needs --confirm and AC0_OPENROUTER_API_KEY
  --confirm <plan-id>   the plan id printed by a dry run of the same options

  Record usage spent outside this script (e.g. browser measurement) in the ledger; sends nothing:
  --record-external-calls <n> --record-external-usd <x> [--external-note <text>]

  The cumulative ledger is always ~/.graylum/ac0/ledger.json and cannot be changed from the command line.
`;

export type ProbeArgs = {
  agentTurn?: boolean;
  skillDir?: string;
  scenarios?: string;
  configIds: string[];
  configFile?: string;
  counts: Record<TrialKind, number>;
  maxCalls: number;
  maxUsd: number;
  maxTokens: number;
  timeoutMs: number;
  outDir: string;
  /** Fixed at ~/.graylum/ac0/ledger.json; only code (tests) can inject another path. */
  ledger: string;
  live: boolean;
  confirm?: string;
  help: boolean;
  /** Manual ledger entry instead of a probe run. */
  external?: {calls: number; usd: number; note?: string};
};

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`PROBE_ARGUMENT_INVALID: --${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

export function parseProbeArgs(argv: string[], home: string): ProbeArgs {
  const {values} = parseArgs({args: argv, strict: true, allowPositionals: false, options: {
    'agent-turn': {type: 'boolean'}, 'skill-dir': {type: 'string'}, scenarios: {type: 'string'}, configs: {type: 'string'}, 'config-file': {type: 'string'},
    ask: {type: 'string'}, text: {type: 'string'}, reference: {type: 'string'},
    'max-calls': {type: 'string'}, 'max-usd': {type: 'string'}, 'max-tokens': {type: 'string'}, 'timeout-ms': {type: 'string'},
    'out-dir': {type: 'string'}, live: {type: 'boolean'}, confirm: {type: 'string'}, help: {type: 'boolean'},
    'record-external-calls': {type: 'string'}, 'record-external-usd': {type: 'string'}, 'external-note': {type: 'string'},
  }});
  const external = parseExternal(values['record-external-calls'], values['record-external-usd'], values['external-note']);
  if (external && values.live) throw new Error('PROBE_ARGUMENT_INVALID: --record-external-* never sends; do not combine with --live');
  const agentTurn = values['agent-turn'] ?? false;
  if (agentTurn && (values.configs || values['config-file'] || external)) throw new Error('PROBE_AGENT_TURN_CONFIG_FIXED');
  const maxUsdText = values['max-usd'];
  if (maxUsdText !== undefined && !/^\d+(\.\d+)?$/.test(maxUsdText)) throw new Error('PROBE_ARGUMENT_INVALID: --max-usd');
  // Cap validation reads the raw request before any default could hide it.
  const maxCalls = integer(values['max-calls'], DEFAULT_MAX_CALLS, 1, Number.MAX_SAFE_INTEGER, 'max-calls');
  const maxUsd = maxUsdText === undefined ? (agentTurn ? 1 : DEFAULT_MAX_USD) : Number(maxUsdText);
  validateCaps(maxCalls, maxUsd);
  return {
    ...(agentTurn ? {agentTurn: true} : {}),
    skillDir: values['skill-dir'],
    scenarios: values.scenarios,
    configIds: (values.configs ?? DEFAULT_CONFIG_IDS.join(',')).split(',').map(id => id.trim()).filter(Boolean),
    configFile: values['config-file'],
    counts: {
      ask: integer(values.ask, 30, 0, 100, 'ask'),
      text: integer(values.text, agentTurn ? 10 : 0, 0, 100, 'text'),
      reference: integer(values.reference, 0, 0, 100, 'reference'),
    },
    maxCalls, maxUsd,
    maxTokens: integer(values['max-tokens'], 1024, 64, 8192, 'max-tokens'),
    timeoutMs: integer(values['timeout-ms'], DEFAULT_TIMEOUT_MS, 5_000, DEFAULT_TIMEOUT_MS, 'timeout-ms'),
    outDir: values['out-dir'] ?? join(home, '.graylum', 'ac0', 'results'),
    ledger: join(home, '.graylum', 'ac0', 'ledger.json'),
    live: values.live ?? false,
    confirm: values.confirm,
    help: values.help ?? false,
    ...(external ? {external} : {}),
  };
}

function parseExternal(calls: string | undefined, usd: string | undefined, note: string | undefined) {
  if (calls === undefined && usd === undefined && note === undefined) return undefined;
  if (calls === undefined || usd === undefined) {
    throw new Error('PROBE_ARGUMENT_INVALID: give both --record-external-calls and --record-external-usd');
  }
  if (!/^\d+(\.\d+)?$/.test(usd) || Number(usd) > 1000) throw new Error('PROBE_ARGUMENT_INVALID: --record-external-usd');
  if (note !== undefined && (note.length > 200 || /[\r\n]/.test(note))) throw new Error('PROBE_ARGUMENT_INVALID: --external-note');
  const entry = {calls: integer(calls, 0, 0, 10_000, 'record-external-calls'), usd: Number(usd)};
  if (entry.calls === 0 && entry.usd === 0) throw new Error('PROBE_ARGUMENT_INVALID: nothing to record');
  return note ? {...entry, note} : entry;
}

export type ProbePlan = {
  agentTurn?: boolean;
  planId: string;
  configs: ProbeConfig[];
  counts: Record<TrialKind, number>;
  maxCalls: number;
  maxUsd: number;
  maxTokens: number;
  timeoutMs: number;
  skillDigest: string;
  skillIsFixture: boolean;
  scenarioDigest: string;
  plannedCalls: number;
  plannedUsdUpperBound: number;
};

/** Upper estimate of what a scenario adds to a request: history items as JSON
 * (question cards appear twice, as the call and its result) and step host text. */
function scenarioBytes(scenario: Scenario, skill: LoadedSkill): number {
  return Buffer.byteLength(scenario.input) + Buffer.byteLength(stepRules(skill, scenario.step)) +
    scenario.history.reduce((sum, item) => sum + 2 * Buffer.byteLength(JSON.stringify(item)), 0);
}

export function buildPlan(args: ProbeArgs, skill: LoadedSkill, scenarios: Scenario[], scenarioDigest: string): ProbePlan {
  const extra = args.configFile ? parsePrivateJson(readFileSync(args.configFile, 'utf8'), z.unknown(), 'CONFIG_FILE') : undefined;
  const configs = args.agentTurn ? [AGENT_TURN_CONFIG] : resolveConfigs(args.configIds, extra);
  if (args.agentTurn && (args.counts.ask !== 30 || args.counts.text !== 10 || args.counts.reference !== 0 || args.maxUsd > 1)) {
    throw new Error('PROBE_AGENT_TURN_PLAN_FIXED: 30 ask + 10 text, no references, at most USD 1');
  }
  let plannedCalls = 0;
  let plannedUsd = 0;
  const referenceBytes = [...skill.references.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  for (const kind of TRIAL_KINDS) {
    const count = args.counts[kind];
    if (!count) continue;
    const pool = scenariosOf(scenarios, kind);
    if (!pool.length) throw new Error(`PROBE_SCENARIOS_MISSING: no "${kind}" scenario for --${kind} ${count}`);
    if (args.agentTurn && pool.length < count) throw new Error('PROBE_AGENT_TURN_DISTINCT_SCENARIOS_REQUIRED');
    const largest = Math.max(...pool.map(scenario => scenarioBytes(scenario, skill) +
      (args.agentTurn ? Buffer.byteLength(agentTurnPrompt(skill, scenario)) : 0)));
    const bytes = Buffer.byteLength(skill.instructions) + largest + REQUEST_OVERHEAD_BYTES +
      (kind === 'reference' ? referenceBytes : 0);
    for (const config of configs) {
      plannedCalls += count * CALLS_PER_TRIAL[kind];
      plannedUsd += count * CALLS_PER_TRIAL[kind] * callBoundUsd(config, bytes, args.maxTokens);
    }
  }
  if (args.agentTurn && plannedUsd > args.maxUsd) throw new Error('PROBE_AGENT_TURN_RUN_BUDGET_INSUFFICIENT');
  if (plannedCalls === 0) throw new Error('PROBE_PLAN_EMPTY');
  if (plannedCalls > args.maxCalls) {
    throw new Error(`PROBE_PLAN_REFUSED: worst case ${plannedCalls} calls exceeds --max-calls ${args.maxCalls}`);
  }
  const identity = {
    ...(args.agentTurn ? {agentTurn: true} : {}),
    configs, counts: args.counts, maxCalls: args.maxCalls, maxUsd: args.maxUsd, maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs, skillDigest: skill.digest, scenarioDigest,
  };
  const planId = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
  return {
    planId, ...identity, skillIsFixture: skill.isFixture, plannedCalls,
    plannedUsdUpperBound: Math.round(plannedUsd * 1e6) / 1e6,
  };
}

export function describePlan(plan: ProbePlan, mode: 'dry-run' | 'live', ledger: {calls: number; usd: number; path?: string}): string {
  const lines = [
    `AC-0b probe plan ${plan.planId} (${mode})`,
    `Skill: ${plan.skillIsFixture ? 'synthetic repository fixture' : 'private directory'} digest ${plan.skillDigest}; ` +
      `scenarios digest ${plan.scenarioDigest}`,
    `Trials per config: ask ${plan.counts.ask}, text ${plan.counts.text}, reference ${plan.counts.reference}; ` +
      `max_tokens ${plan.maxTokens}; timeout ${plan.timeoutMs} ms`,
    'Configs (every call: only=<route>, allow_fallbacks=false, require_parameters=true, max_price):',
    ...plan.configs.map(config => `  ${config.id}: ${config.model} via ${config.route}, ${thinkingLabel(config)}, ` +
      `data_collection=${config.dataCollection === 'omit' ? 'omitted' : 'deny'}, ` +
      `max_price ${config.maxPrice.prompt}/${config.maxPrice.completion} USD per M tokens`),
    `Worst case: ${plan.plannedCalls} provider calls, $${plan.plannedUsdUpperBound.toFixed(4)} (bytes counted as tokens)`,
    `Run caps: ${plan.maxCalls} calls, $${plan.maxUsd}; the run stops before a call that would exceed either`,
    `Cumulative ledger before this run: ${ledger.calls} calls, $${ledger.usd.toFixed(6)} booked of ${HARD_MAX_CALLS} calls / $${HARD_MAX_USD}`,
  ];
  if (ledger.path) lines.push(`Ledger file (real path): ${ledger.path}`);
  if (mode === 'dry-run') lines.push(`Dry run: no request leaves this machine. For real calls add: --live --confirm ${plan.planId}`);
  return lines.join('\n') + '\n';
}
