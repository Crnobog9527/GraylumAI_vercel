/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hash, read, lines, save, assert, loadSource, canReserve,
  expectedManifest, capNano, settlementNano } from './cdc-b2-eval/reasoningSource.mjs';
import { root, profiles, variant, reserveNano, catalog } from './cdc-b2-eval/capabilitySource.mjs';

const [mode, expectedHash] = process.argv.slice(2);
assert(['prepare', 'execute', 'metrics'].includes(mode), 'USAGE_PREPARE_EXECUTE_METRICS');
const source = loadSource();
const runnerHash = () => hash(['cdc-b2-capability.mjs', 'cdc-b2-eval/reasoningSource.mjs', 'cdc-b2-eval/capabilitySource.mjs']
  .map(name => hash(readFileSync(new URL(name, import.meta.url)))).join('\n'));
const ledgerPath = join(root, 'ledger.json');

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(240000), ...options });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    assert(size <= 8 * 1024 * 1024, 'RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return { status: response.status, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
}
function calls(efforts) {
  return efforts.flatMap(effort => source.organizers.map(q => {
    const raw = variant(q.raw, effort);
    return { effort, slot: q.slot, baselineOrdinal: q.ordinal, requestHash: hash(raw), reserveNano: reserveNano(raw, effort) };
  }));
}
function baselineIdentity() {
  return hash(JSON.stringify(source.organizers.map(q => [q.slot, q.requestHash,
    source.responses.find(r => r.ordinal === q.ordinal).responseHash])));
}

if (mode === 'prepare') {
  assert(!expectedHash && !existsSync(join(root, 'manifest.json')) && !existsSync(join(root, 'started.lock')), 'PREPARE_ALREADY_EXISTS');
  const metadata = await catalog();
  const efforts = Object.keys(profiles);
  const rows = calls(efforts);
  mkdirSync(root, { mode: 0o700, recursive: true });
  save(join(root, 'catalog.json'), metadata);
  const manifest = { version: 1, baselineManifest: expectedManifest, baselineIdentity: baselineIdentity(),
    runnerHash: runnerHash(), catalogHash: hash(readFileSync(join(root, 'catalog.json'))),
    capNano, efforts, rows, sumReservesNano: rows.reduce((sum, q) => sum + q.reserveNano, 0),
    baselineLabel: 'round-two provider default; request omitted reasoning; not explicit none' };
  save(join(root, 'manifest.json'), manifest);
  console.log(JSON.stringify({ manifestHash: hash(JSON.stringify(manifest)), efforts,
    calls: rows.length, sumReservesUsd: manifest.sumReservesNano / 1e9 }));
}

if (mode === 'execute') {
  const manifest = read(join(root, 'manifest.json'));
  assert(expectedHash === hash(JSON.stringify(manifest)), 'EXPERIMENT_MANIFEST_CHANGED');
  assert(manifest.runnerHash === runnerHash() && manifest.baselineIdentity === baselineIdentity(), 'EXPERIMENT_SOURCE_CHANGED');
  assert(manifest.catalogHash === hash(readFileSync(join(root, 'catalog.json'))), 'EXPERIMENT_CATALOG_CHANGED');
  assert(manifest.efforts.join(',') === Object.keys(profiles).join(','), 'EXPERIMENT_EFFORTS');
  assert(manifest.capNano === capNano && JSON.stringify(manifest.rows) === JSON.stringify(calls(manifest.efforts)), 'EXPERIMENT_ROSTER');
  const replay = read(join(root, '../cdc-reasoning-20261006/host-replay-baseline/proof.json'));
  assert(replay.baselineManifest === expectedManifest && replay.organizerInputsMatch === 30 &&
    replay.baselineWritesMatch === 30 && replay.externalDispatches === 0, 'BASELINE_REPLAY_REQUIRED');
  const key = process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY;
  assert(key, 'TEST_KEY_MISSING');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const credits = await request('https://openrouter.ai/api/v1/credits', { headers });
  assert(credits.status === 200, 'CREDITS_HTTP');
  const balance = JSON.parse(credits.body).data;
  assert(balance.total_credits - balance.total_usage >= 1, 'TEST_BALANCE_INSUFFICIENT');
  // Fixed one-shot location: neither a new output path nor a new manifest can reset the budget.
  writeFileSync(join(root, 'started.lock'), expectedHash, { flag: 'wx', mode: 0o600 });
  save(ledgerPath, { settledNano: 0, pendingNano: 0, dispatched: 0, status: 'running' });
  const update = state => writeFileSync(ledgerPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    for (const [index, row] of manifest.rows.entries()) {
      const raw = variant(source.organizers.find(q => q.slot === row.slot).raw, row.effort);
      assert(hash(raw) === row.requestHash && reserveNano(raw, row.effort) === row.reserveNano, 'REQUEST_CHANGED');
      const state = read(ledgerPath);
      assert(canReserve(state.settledNano, state.pendingNano, row.reserveNano), 'BUDGET_STOP');
      const pending = { ...state, dispatched: index + 1, pendingNano: row.reserveNano, current: row.requestHash };
      update(pending);
      const startedAt = new Date().toISOString(), start = performance.now();
      const result = await request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: raw });
      const elapsedMs = performance.now() - start;
      const record = { ...row, ordinal: index + 1, startedAt, endedAt: new Date().toISOString(), elapsedMs, ...result };
      appendFileSync(join(root, 'responses.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
      assert(result.status === 200, 'PROVIDER_HTTP_STOP');
      const body = JSON.parse(result.body), cost = body.usage?.cost;
      const actualNano = settlementNano(cost, row.reserveNano);
      update({ ...pending, settledNano: pending.settledNano + actualNano, pendingNano: 0 });
      assert(body.provider === profiles[row.effort].provider, 'PROVIDER_ROUTE_STOP');
      assert(['stop', 'length'].includes(body.choices?.[0]?.finish_reason), 'FINISH_UNKNOWN_STOP');
      // A known-cost length/invalid-JSON response is a failed sample, never retried or replaced.
      console.log(JSON.stringify({ completed: index + 1, effort: row.effort, cost,
        elapsedMs: Math.round(elapsedMs), finish: body.choices[0].finish_reason,
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null }));
    }
    update({ ...read(ledgerPath), status: 'completed' });
  } catch (error) {
    update({ ...read(ledgerPath), status: 'stopped', error: error instanceof Error ? error.message : 'UNKNOWN' });
    throw error;
  }
}

if (mode === 'metrics') {
  assert(!expectedHash, 'METRICS_USAGE');
  const key = process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY;
  assert(key, 'TEST_KEY_MISSING');
  const base = read(join(root, '../cdc-reasoning-20261006/generation-metrics.json')).filter(r => r.effort === 'baseline');
  const fresh = existsSync(join(root, 'responses.jsonl')) ? lines(join(root, 'responses.jsonl')) : [];
  assert(!existsSync(join(root, 'generation-metrics.json')), 'METRICS_ALREADY_RECORDED');
  const out = [...base];
  // Read-only generation lookup, once per recorded call; no model dispatch or retry.
  for (const row of fresh) {
    const id = JSON.parse(row.body).id;
    try {
      const result = await request(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,
        { headers: { authorization: `Bearer ${key}` } });
      out.push({ effort: row.effort, slot: row.slot, status: result.status,
        data: result.status === 200 ? JSON.parse(result.body).data : null });
    } catch { out.push({ effort: row.effort, slot: row.slot, status: 'unavailable', data: null }); }
  }
  save(join(root, 'generation-metrics.json'), out);
  console.log(JSON.stringify({ lookups: out.length, available: out.filter(x => x.status === 200).length }));
}
