/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The 100-user acceptance driver (CORE-PATH-V2 plan 3.2): drives POST /api/turn on STAGING with the model stub behind it, in the stages of
// the plan (30 -> 50 -> 75 -> 100 -> 50 -> 100, 2.5 minutes each, 10 minutes cooling between). It holds no address, key, token or id:
//   LOADTEST_BASE_URL         the staging app URL
//   LOADTEST_ALLOWED_HOST     the exact host of that URL; the driver refuses any other
//   LOADTEST_ACCOUNTS_FILE    a JSON file OUTSIDE the repository: { "accounts": [{ "token", "sessionId", "moduleId"?, "stepId"? }] },
//                             one account per user (100 for the full run); tokens are read here and never printed or logged.
//                             `cookie` (optional): the session cookie header; tRPC reads (library) need it, POST /api/turn uses the token
// Without --go it only prints the plan (a dry run); a run needs --go, which the controller gives after the switch to the new path.
// Usage: node scripts/loadtest/core-path-load.mjs --out <dir outside the repository> [--series | --stage 30] [--go] [--cooldown-ms 600000]
//   [--mix chat:5,coach:3,library:2]
//   --calibrate [--turns 12]: ONE user, serial chat turns, 1 s apart, nothing else: the per-turn overhead with no contention (Vercel run plan)
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { STAGES, STAGE_MS, RAMP_MS, COOLDOWN_MS, MIX, kindsOf, thinkMs, parseSse, outcomeOf, summarizeStage } from './lib/core.mjs';
import { classifyFixedOverhead } from './lib/connections.mjs';
import { assertOutsideRepo } from './reset-accounts.mjs';

const flag = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes('--' + name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function assertStaging(url, allowedHost) {
  const parsed = new URL(url);
  if (!allowedHost || parsed.hostname !== allowedHost) throw new Error('refusing: LOADTEST_BASE_URL host is not LOADTEST_ALLOWED_HOST');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('refusing: https only');
  return parsed.origin;
}

// A stage that is failing hard stops early instead of piling more load on staging: after 20 turns, more than 30% failed.
export const shouldAbort = records => {
  const turns = records.filter(r => /\.turn$/.test(r.op));
  return turns.length >= 20 && turns.filter(r => !r.ok).length / turns.length > 0.3;
};

export function plan({ series, stage, mix = MIX }) {
  const stages = series ? STAGES : [Number(stage)];
  return stages.map((vus, i) => ({ index: i + 1, vus, kinds: kindsOf(vus, mix) }));
}

// `x-vercel-id` is "<edge>::<function region>::<id>" on a deployed app and absent on a local one: the function region says where the turn ran.
export const regionOf = headers => (headers?.get?.('x-vercel-id') ?? '').split('::').filter(Boolean).slice(0, 2).join('>') || null;

// Where the requests ran (function regions from x-vercel-id) and how many were refused by a rate limit (HTTP 429).
export const placeOf = records => {
  const regions = {};
  for (const r of records) if (r.region) regions[r.region] = (regions[r.region] ?? 0) + 1;
  return { regions, rateLimited: records.filter(r => r.code === 'HTTP_429').length };
};
export const STUB_CHAT_SECONDS = 6; // openrouter-stub.mjs: 1.5 s first byte + 90 chunks x 50 ms

export const hasTextDelta = text => parseSse(text).some(e => e.type === 'text' && typeof e.delta === 'string' && e.delta.length > 0);

async function turnRequest(base, account, body, started) {
  const response = await fetch(`${base}/api/turn`, { method: 'POST', headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const region = regionOf(response.headers);
  if (!response.ok) return { ok: false, code: `HTTP_${response.status}`, region };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', firstByteMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    // First-token latency is the first non-empty `text` event (plan 3.1), not the first chunk: `opened` comes before the model is called.
    if (firstByteMs === null && hasTextDelta(text)) firstByteMs = Date.now() - started;
  }
  const outcome = outcomeOf(parseSse(text));
  return { ok: outcome.ok, code: outcome.code, firstByteMs, region };
}

export async function readRequest(base, account, path, input) {
  const response = await fetch(`${base}/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
    { headers: { authorization: `Bearer ${account.token}`, ...(account.cookie ? { cookie: account.cookie } : {}) } });
  return { ok: response.ok, code: response.ok ? null : `HTTP_${response.status}`, region: regionOf(response.headers) };
}

export async function runStage({ base, accounts, kinds, record, deadline, stopped = () => false, stageNumber, think = thinkMs }) {
  const timed = async (vu, op, fn) => {
    const started = Date.now();
    try { const r = await fn(started); record({ stage: stageNumber, vu, op, ms: Date.now() - started, ...r }); }
    catch (error) { record({ stage: stageNumber, vu, op, ok: false, ms: Date.now() - started, code: String(error.code ?? error.name).slice(0, 60) }); }
  };
  await Promise.all(kinds.map(async (kind, vu) => {
    await sleep((vu / kinds.length) * RAMP_MS);
    const account = accounts[vu];
    for (let n = 0; Date.now() < deadline && !stopped(); n++) {
      if (kind === 'library') {
        await timed(vu, 'library.list', () => readRequest(base, account, 'library.list', {}));
        await timed(vu, 'library.search', () => readRequest(base, account, 'library.search', { query: '定位' }));
        await sleep(think() / 2);
        continue;
      }
      const body = kind === 'chat'
        ? { kind: 'chat', sessionId: account.sessionId, requestId: randomUUID(), text: `load round ${n + 1}: how do I start a workplace channel?` }
        : { kind: 'mentor', sessionId: account.sessionId, requestId: randomUUID(), moduleId: account.moduleId, stepId: account.stepId ?? 'step-1',
          text: `load round ${n + 1}: I train people at work and want customers.`, organizeAfter: true };
      await timed(vu, `${kind}.turn`, started => turnRequest(base, account, body, started));
      await sleep(think());
    }
  }));
}

async function main() {
  const out = flag('out', null);
  if (!out) throw new Error('--out <dir outside the repository> is required');
  assertOutsideRepo(join(out, 'x'));
  const mix = flag('mix') ? Object.fromEntries(flag('mix').split(',').map(p => p.split(':')).map(([k, w]) => [k, Number(w)])) : MIX;
  const calibrate = has('calibrate');
  const stages = calibrate ? [{ index: 0, vus: 1, kinds: ['chat'] }] : plan({ series: has('series'), stage: flag('stage', 30), mix });
  console.log(calibrate ? `calibration: 1 user, ${flag('turns', 12)} serial chat turns`
    : `plan: ${stages.map(s => s.vus).join(' -> ')} users, ${STAGE_MS / 60000} min each, cooling ${COOLDOWN_MS / 60000} min between`);
  if (!has('go')) { console.log('dry run (no --go): nothing was sent'); return; }
  const base = assertStaging(process.env.LOADTEST_BASE_URL ?? '', process.env.LOADTEST_ALLOWED_HOST);
  const accounts = JSON.parse(readFileSync(process.env.LOADTEST_ACCOUNTS_FILE ?? '', 'utf8')).accounts ?? [];
  const most = Math.max(...stages.map(s => s.vus));
  if (accounts.length < most) throw new Error(`need ${most} accounts, the file has ${accounts.length}`);
  mkdirSync(out, { recursive: true });
  // One driver at a time against staging: the same accounts in two runs mix their input (and it is the single-lane rule).
  const lock = openSync(join(out, 'RUNNING.lock'), 'wx');
  closeSync(lock);
  const summaries = [];
  try {
    for (const stage of stages) {
      const file = join(out, `stage-${stage.index}-${stage.vus}.jsonl`);
      const records = [];
      const record = r => { records.push(r); appendFileSync(file, JSON.stringify({ t: Date.now(), ...r }) + '\n'); };
      const turnsWanted = Number(flag('turns', 12));
      const deadline = Date.now() + (calibrate ? 600_000 : STAGE_MS);
      let abort = false;
      const watch = setInterval(() => {
        if (!shouldAbort(records)) return;
        console.error(`stage ${stage.index}: aborted, more than 30% of turns failed`);
        abort = true;
      }, 5000);
      console.log(`stage ${stage.index}: ${stage.vus} users`);
      await runStage({ base, accounts, kinds: stage.kinds, record, stageNumber: stage.index, deadline,
        stopped: () => abort || (calibrate && records.filter(r => /\.turn$/.test(r.op)).length >= turnsWanted), think: calibrate ? () => 1000 : thinkMs });
      clearInterval(watch);
      const summary = { stage: stage.index, vus: stage.vus, ...summarizeStage(records), aborted: abort, ...placeOf(records) };
      if (calibrate) summary.overhead = classifyFixedOverhead({ p50Ms: summary.p50Ms, stubSeconds: STUB_CHAT_SECONDS });
      summaries.push(summary);
      writeFileSync(join(out, `stage-${stage.index}-${stage.vus}.summary.json`), JSON.stringify(summary, null, 1) + '\n');
      console.log(JSON.stringify(summary));
      if (summary.aborted) break;
      if (stage !== stages[stages.length - 1]) await sleep(Math.max(COOLDOWN_MS, Number(flag('cooldown-ms', COOLDOWN_MS))));
    }
    const first = summaries.find(s => s.vus === 30);
    if (first) console.log('30-user baseline p95 (ms):', first.p95Ms, '- judge it against the previous batch with baselineValid()');
  } finally { rmSync(join(out, 'RUNNING.lock'), { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
