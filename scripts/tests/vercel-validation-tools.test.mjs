/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStub } from '../loadtest/openrouter-stub.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverage } from '../loadtest/lib/coverage.mjs';
import { summarizeConnections, judgeConnections, classifyFixedOverhead } from '../loadtest/lib/connections.mjs';
import { readManagedLimits } from '../loadtest/sample-connections.mjs';
import { regionOf, placeOf } from '../loadtest/core-path-load.mjs';

const row = (usename, n, state = 'idle', backend_type = 'client backend', application_name = '') =>
  ({ usename, application_name, state, backend_type, n });

test('connection summary keeps the peak per role and ignores background workers', () => {
  const summary = summarizeConnections([
    { t: 1, idleInTxMaxSeconds: 0,
      rows: [row('authenticator', 6, 'active'), row('supabase_auth_admin', 3), row('postgres', 9, 'active', 'autovacuum worker')] },
    { t: 2, rows: [row('authenticator', 8, 'active'), row('supabase_auth_admin', 2)], idleInTxMaxSeconds: 1.26 },
  ], { maxConnections: 60, reserved: 3, postgrestPool: 8 });
  assert.equal(summary.peakTotal, 10);
  assert.equal(summary.peakActive, 8);
  assert.deepEqual(summary.peakByRole, { authenticator: 8, supabase_auth_admin: 3 });
  assert.equal(summary.idleInTxMaxSeconds, 1.3);
  assert.ok(judgeConnections(summary).every(c => c.ok && c.known));
});

test('connection checks fail on over-limit, idle in transaction, and unknown values', () => {
  const rows = [row('authenticator', 20, 'active'), row('x', 30)];
  const over = summarizeConnections([{ t: 1, rows, idleInTxMaxSeconds: 9 }], { maxConnections: 60, reserved: 3 });
  const checks = judgeConnections(over);
  assert.deepEqual(checks.map(c => c.ok), [false, false, false]);
  assert.equal(checks[0].limit, 42); // 75% of 57 usable
  assert.equal(checks[1].limit, 8); // assumed staging pool when the management API gave none
  const none = judgeConnections(summarizeConnections([], {}));
  assert.ok(none.every(c => !c.ok && !c.known), 'no samples and no limits is not a pass');
});

test('fixed overhead is reported as extra seconds with an undetermined source unless a network baseline exists', () => {
  const none = classifyFixedOverhead({ p50Ms: 15000, stubSeconds: 6 });
  assert.equal(none.overheadSeconds, 9);
  assert.equal(none.source, 'undetermined');
  assert.doesNotMatch(none.reading, /serial|in the turn|local round trip, not the app/);
  assert.match(classifyFixedOverhead({ p50Ms: 7500, stubSeconds: 6, roundTripMs: 1000 }).reading, /within the line/);
  const far = classifyFixedOverhead({ p50Ms: 15000, stubSeconds: 6, roundTripMs: 1000 });
  assert.equal(far.residualSeconds, 8);
  assert.equal(far.source, 'undetermined');
  assert.equal(classifyFixedOverhead({ p50Ms: null, stubSeconds: 6 }).reading, 'not measured');
});

test('connection peak counts the whole instance and lists the current database apart', () => {
  const rows = [{ current_db: true, usename: 'authenticator', state: 'idle', backend_type: 'client backend', n: 5 },
    { current_db: false, usename: 'postgres', state: 'active', backend_type: 'client backend', n: 3 }];
  const summary = summarizeConnections([{ rows, idleInTxMaxSeconds: 0 }], { maxConnections: 10, reserved: 0 });
  assert.equal(summary.peakTotal, 8);
  assert.equal(summary.peakCurrentDb, 5);
  assert.equal(judgeConnections(summary)[0].ok, false); // 8 > 75% of 10
});


test('managed limits are read with GET only, kept as numbers, and missing without a token', async () => {
  assert.deepEqual(await readManagedLimits({}, async () => { throw new Error('no call expected'); }), {});
  const seen = [];
  const limits = await readManagedLimits({ SUPABASE_MANAGEMENT_TOKEN: 't', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' }, async (url, init) => {
    seen.push([url, init.method ?? 'GET']);
    const pooler = [{ pool_mode: 'transaction', default_pool_size: 15, max_client_conn: 200 }];
    return { ok: true, json: async () => (url.endsWith('/pooler') ? pooler : { db_pool: 8, secret: 'x' }) };
  });
  assert.deepEqual(limits, { poolerMode: 'transaction', poolerDefaultPoolSize: 15, poolerMaxClientConn: 200, postgrestPool: 8 });
  assert.ok(seen.every(([, method]) => method === 'GET'));
  assert.deepEqual(await readManagedLimits({ SUPABASE_MANAGEMENT_TOKEN: 't', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' }, async () => ({ ok: false })), {
    poolerMode: undefined, poolerDefaultPoolSize: undefined, poolerMaxClientConn: undefined, postgrestPool: undefined });
});

test('driver records the function region and counts 429s', () => {
  assert.equal(regionOf(new Headers({ 'x-vercel-id': 'sfo1::pdx1::abc-123' })), 'sfo1>pdx1');
  assert.equal(regionOf(new Headers()), null);
  const records = [{ region: 'sfo1>pdx1', ok: true }, { region: 'sfo1>pdx1', code: 'HTTP_429' }, { ok: true }];
  assert.deepEqual(placeOf(records), { regions: { 'sfo1>pdx1': 2 }, rateLimited: 1 });
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

test('sampler coverage fails when samples start after, or stop before, the driver window', () => {
  const window = { startMs: 1000, endMs: 11000 };
  assert.equal(coverage([500, 6000, 11500], window, 2000).ok, true);
  assert.equal(coverage([4000, 6000, 11500], window, 2000).ok, false); // started late
  assert.equal(coverage([500, 6000, 8000], window, 2000).ok, false); // stopped early
  assert.equal(coverage([], window, 2000).ok, false);
});

const runAll = (extra = {}) => spawnSync('bash', ['scripts/loadtest/run-all.sh', '--dry-run'], {
  cwd: join(import.meta.dirname, '../..'), encoding: 'utf8', env: { ...process.env, DRY_DRIVER_SECONDS: '2', ...extra } });

test('run-all dry run starts the driver and both samplers with their own hosts and covers the driver window', () => {
  const root = mkdtempSync(join(tmpdir(), 'runall-'));
  const result = runAll({ RUN_ROOT: root, LOADTEST_ALLOWED_APP_HOST: 'app.example.test', LOADTEST_ALLOWED_DB_HOST: 'db.other.test' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /COVERED .*connections\.jsonl/);
  assert.match(result.stdout, /COVERED .*waits\.jsonl/);
  assert.match(result.stdout, /driver app\.example\.test/);
  assert.match(result.stdout, /connections db\.other\.test/);
});

test('run-all refuses a directory holding an earlier run and a second run reads only its own files', () => {
  const root = mkdtempSync(join(tmpdir(), 'runall-'));
  const stale = join(root, 'run-old');
  mkdirSync(stale);
  writeFileSync(join(stale, 'connections.jsonl'), JSON.stringify({ t: 1, rows: [] }) + '\n'); // far outside any window
  const refused = runAll({ RUN_DIR: stale });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already holds files/);
  assert.equal(readFileSync(join(stale, 'connections.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  const fresh = runAll({ RUN_ROOT: root });
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.doesNotMatch(fresh.stdout, /run-old/);
});

const selfcheck = async (driverCmd) => {
  const stub = createStub({ prefix: 'p' });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${stub.address().port}`;
  // the check only accepts https for the real tunnel; here the origin is read with URL(), which is protocol-agnostic
  const child = spawn('bash', ['scripts/loadtest/selfcheck.sh'], { cwd: join(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LOADTEST_MODEL_STUB_URL: `${base}/p`, LOADTEST_ALLOWED_APP_HOST: 'app.example.test',
      DRIVER_CMD: driverCmd.replaceAll('BASE', base) } });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const status = await new Promise(resolve => child.on('close', resolve));
  const run = { status, stdout, stderr };
  stub.close();
  return run;
};

test('selfcheck passes only when the stub counter goes up during the one-account turn', async () => {
  // the stream check of the tunnel already called the stub once: that must not count
  const hit = await selfcheck(`curl -s -m 10 -H 'content-type: application/json' -d '{"model":"x","stream":false,"messages":[{"role":"user","content":"hi"}]}' BASE/p/api/v1/chat/completions >/dev/null`);
  assert.equal(hit.status, 0, hit.stdout + hit.stderr);
  assert.match(hit.stdout, /PASS/);
  const miss = await selfcheck('true');
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /NOT rerouted/);
  const failed = await selfcheck('exit 3');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /turn failed/);
});
