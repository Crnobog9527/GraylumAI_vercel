/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const root = join(homedir(), '.graylum/cdc-reasoning-20261006');
export const sourceRoot = join(homedir(), '.graylum/cdc-b2-eval');
export const baseline = join(sourceRoot, 'freeze-round2-02');
export const expectedManifest = 'ee8f408ba6e34635216b3b8aefd977ad0c9af0d675a1060f2fba97b1cc181edd';
export const capNano = 1_000_000_000;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const read = path => JSON.parse(readFileSync(path, 'utf8'));
export const lines = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
export function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
}
export function assert(ok, code) { if (!ok) throw new Error(code); }

export function loadSource() {
  const manifest = read(join(baseline, 'manifest.json'));
  assert(hash(JSON.stringify(manifest)) === expectedManifest, 'SOURCE_MANIFEST_CHANGED');
  const input = readFileSync(join(sourceRoot, 'round2-input.json'));
  assert(hash(input) === manifest.inputHash, 'SOURCE_INPUT_CHANGED');
  assert(hash(readFileSync(join(baseline, 'frozen-private.json'))) === manifest.privateHash, 'SOURCE_FREEZE_CHANGED');
  const live = join(baseline, 'live');
  const liveManifest = read(join(live, 'manifest.json'));
  assert(liveManifest.sourceHash === manifest.sourceHash, 'SOURCE_LIVE_CODE_CHANGED');
  assert(hash(readFileSync(join(live, 'frozen-private.json'))) === liveManifest.privateHash, 'SOURCE_LIVE_CHANGED');
  const full = read(join(live, 'frozen-private.json'));
  const requests = lines(join(live, 'requests.jsonl'));
  const responses = lines(join(live, 'responses.jsonl'));
  assert(requests.length === 100 && responses.length === 100, 'SOURCE_INCOMPLETE');
  for (const q of requests) {
    const r = responses.find(r => r.ordinal === q.ordinal);
    const frozen = full.rows.find(row => row.ordinal === q.ordinal);
    assert(r && frozen && frozen.raw === q.raw && hash(q.raw) === q.requestHash, 'SOURCE_REQUEST_CHANGED');
    assert(hash(r.body) === r.responseHash && r.slot === q.slot && r.role === q.role, 'SOURCE_RESPONSE_CHANGED');
    if (q.role === 'organizer') {
      const result = full.results.find(row => row.slot === q.slot);
      assert(result?.result.summary === JSON.parse(r.body).choices[0].message.content, 'SOURCE_SUMMARY_CHANGED');
    }
  }
  const plan = JSON.parse(input);
  const groups = plan.groups.filter(g => g.turns.some(t => t.organize));
  const organizers = requests.filter(q => q.role === 'organizer');
  assert(groups.length === 10 && groups.every(g => g.turns.length === 3 && g.turns.every(t => t.organize)), 'SOURCE_ROSTER');
  assert(organizers.length === 30 && new Set(organizers.map(q => q.slot)).size === 30, 'SOURCE_ORGANIZERS');
  const lock = read(join(sourceRoot, 'blind-round2/lock.json'));
  for (const name of ['packet', 'scores']) {
    assert(hash(readFileSync(join(sourceRoot, `blind-round2/${name}.json`))) === lock[`${name}Sha256`], 'SOURCE_SCORE_LOCK');
  }
  return { manifest, liveManifest, plan, groups, organizers, requests, responses, full, lock };
}

export function variant(raw, effort) {
  assert(['low', 'medium', 'high'].includes(effort), 'EFFORT');
  const body = JSON.parse(raw);
  assert(body.model === 'openai/gpt-6-luna' && body.max_tokens === 2048 && body.stream === false && body.store === false,
    'REQUEST_PROFILE');
  assert(body.reasoning === undefined && body.reasoning_effort === undefined, 'BASELINE_REASONING_CHANGED');
  const routing = { allow_fallbacks: false, require_parameters: true, only: ['openai'],
    max_price: { prompt: 0.25, completion: 0.75, request: 0 } };
  assert(JSON.stringify(body.provider) === JSON.stringify(routing), 'REQUEST_ROUTE');
  const next = JSON.stringify({ ...body, reasoning_effort: effort });
  assert(Buffer.byteLength(next) <= 64000, 'REQUEST_INPUT_LIMIT');
  return next;
}

// Same conservative byte + 8192 token bound and frozen price ceilings as round two.
// 0.25 USD/M input (also covers catalog cache writes), 0.75 USD/M total output.
export function reserveNano(raw) { return (Buffer.byteLength(raw) + 8192) * 250 + 2048 * 750; }
export function canReserve(settled, pending, reserve) {
  return [settled, pending, reserve].every(Number.isSafeInteger) && settled >= 0 && pending === 0 &&
    reserve > 0 && settled + reserve <= capNano;
}
export function settlementNano(cost, reservation) {
  assert(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0, 'COST_UNKNOWN_STOP');
  const actual = Math.ceil(cost * 1e9);
  assert(Number.isSafeInteger(actual) && actual <= reservation, 'RESERVE_EXCEEDED_STOP');
  return actual;
}
