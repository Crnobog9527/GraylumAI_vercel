/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStub } from '../loadtest/openrouter-stub.mjs';
import { summarizeConnections, judgeConnections, classifyFixedOverhead } from '../loadtest/lib/connections.mjs';
import { readManagedLimits } from '../loadtest/sample-connections.mjs';
import { regionOf, placeOf } from '../loadtest/core-path-load.mjs';

const row = (usename, n, state = 'idle', backend_type = 'client backend', application_name = '') => ({ usename, application_name, state, backend_type, n });

test('connection summary keeps the peak per role and ignores background workers', () => {
  const summary = summarizeConnections([
    { t: 1, rows: [row('authenticator', 6, 'active'), row('supabase_auth_admin', 3), row('postgres', 9, 'active', 'autovacuum worker')], idleInTxMaxSeconds: 0 },
    { t: 2, rows: [row('authenticator', 8, 'active'), row('supabase_auth_admin', 2)], idleInTxMaxSeconds: 1.26 },
  ], { maxConnections: 60, reserved: 3, postgrestPool: 8 });
  assert.equal(summary.peakTotal, 10);
  assert.equal(summary.peakActive, 8);
  assert.deepEqual(summary.peakByRole, { authenticator: 8, supabase_auth_admin: 3 });
  assert.equal(summary.idleInTxMaxSeconds, 1.3);
  assert.ok(judgeConnections(summary).every(c => c.ok && c.known));
});

test('connection checks fail on over-limit, idle in transaction, and unknown values', () => {
  const over = summarizeConnections([{ t: 1, rows: [row('authenticator', 20, 'active'), row('x', 30)], idleInTxMaxSeconds: 9 }], { maxConnections: 60, reserved: 3 });
  const checks = judgeConnections(over);
  assert.deepEqual(checks.map(c => c.ok), [false, false, false]);
  assert.equal(checks[0].limit, 42); // 75% of 57 usable
  assert.equal(checks[1].limit, 8); // assumed staging pool when the management API gave none
  const none = judgeConnections(summarizeConnections([], {}));
  assert.ok(none.every(c => !c.ok && !c.known), 'no samples and no limits is not a pass');
});

test('fixed overhead reading follows the line and the 5 second split', () => {
  assert.match(classifyFixedOverhead({ p50Ms: 7500, stubSeconds: 6 }).reading, /local round trip, not the app/);
  assert.match(classifyFixedOverhead({ p50Ms: 9500, stubSeconds: 6 }).reading, /partly/);
  assert.match(classifyFixedOverhead({ p50Ms: 15000, stubSeconds: 6 }).reading, /serial work inside the turn/);
  assert.equal(classifyFixedOverhead({ p50Ms: null, stubSeconds: 6 }).reading, 'not measured');
});

test('managed limits are read with GET only, kept as numbers, and missing without a token', async () => {
  assert.deepEqual(await readManagedLimits({}, async () => { throw new Error('no call expected'); }), {});
  const seen = [];
  const limits = await readManagedLimits({ SUPABASE_MANAGEMENT_TOKEN: 't', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' }, async (url, init) => {
    seen.push([url, init.method ?? 'GET']);
    return { ok: true, json: async () => (url.endsWith('/pooler') ? [{ pool_mode: 'transaction', default_pool_size: 15, max_client_conn: 200 }] : { db_pool: 8, secret: 'x' }) };
  });
  assert.deepEqual(limits, { poolerMode: 'transaction', poolerDefaultPoolSize: 15, poolerMaxClientConn: 200, postgrestPool: 8 });
  assert.ok(seen.every(([, method]) => method === 'GET'));
  assert.deepEqual(await readManagedLimits({ SUPABASE_MANAGEMENT_TOKEN: 't', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' }, async () => ({ ok: false })), {
    poolerMode: undefined, poolerDefaultPoolSize: undefined, poolerMaxClientConn: undefined, postgrestPool: undefined });
});

test('driver records the function region and counts 429s', () => {
  assert.equal(regionOf(new Headers({ 'x-vercel-id': 'sfo1::pdx1::abc-123' })), 'sfo1>pdx1');
  assert.equal(regionOf(new Headers()), null);
  assert.deepEqual(placeOf([{ region: 'sfo1>pdx1', ok: true }, { region: 'sfo1>pdx1', code: 'HTTP_429' }, { ok: true }]), { regions: { 'sfo1>pdx1': 2 }, rateLimited: 1 });
});

test('a stub with a secret prefix answers only under it; healthz and stats are open', async t => {
  const server = createStub({ firstByteMs: 5, intervalMs: 1, chunks: 2, prefix: 'sekret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/chat/completions`, { method: 'POST', body: '{"model":"m"}' })).status, 404);
  const ok = await fetch(`${origin}/sekret/api/v1/chat/completions`, { method: 'POST', body: '{"model":"m","stream":true}' });
  assert.equal(ok.status, 200);
  await ok.text();
  const stats = await (await fetch(`${origin}/__stats`)).json();
  assert.equal(stats.calls, 1);
  assert.equal(stats.peak, 1);
});
