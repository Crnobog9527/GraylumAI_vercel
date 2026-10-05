/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local PostgreSQL + the repository's pinned PostgREST; no remote inputs or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE, POSTGREST_IMAGE } from '../v3/images.mjs';

assert.deepEqual(process.argv.slice(2), ['--local-only']);
const root = resolve(import.meta.dirname, '../../../..');
const options = { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
  maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] };
const endpoint = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], options).trim();
assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'));
const docker = (args, input) => execFileSync('docker', ['--host', endpoint, ...args], { ...options, input }).trim();
const tag = `graylum-channel-${randomUUID().slice(0, 8)}`, db = `${tag}-db`, rest = `${tag}-rest`;
const sql = text => docker(['exec', '-i', db, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'fixture',
  '-v', 'ON_ERROR_STOP=1'], text);
const source = readFileSync(resolve(root, 'packages/db/migrations/0173_pay_common_channel.sql'), 'utf8');
const migration = readFileSync(resolve(root, 'packages/db/migrations/0175_pay_common_channel_conflict.sql'), 'utf8');
const guard = source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.pay_common_channel_setting_guard()'),
  source.indexOf('CREATE OR REPLACE FUNCTION public.pay_common_create_purchase('));
const report = {};
try {
  docker(['image', 'inspect', POSTGRES_IMAGE]);
  docker(['image', 'inspect', POSTGREST_IMAGE]);
  docker(['network', 'create', tag]);
  docker(['run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=fixture', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = docker(['exec', db, 'cat', '/proc/1/comm']) === 'postgres'; sql('SELECT 1'); }
    catch { ready = false; }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  // Narrow fixture uses the actual migration's trigger, including locks and insert/upsert behavior.
  sql(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE system_settings(key text PRIMARY KEY, value jsonb);
    GRANT ALL ON system_settings TO service_role;
    ${guard}
    CREATE SEQUENCE attempts;
    GRANT USAGE ON attempts TO service_role;
    CREATE FUNCTION count_attempt() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN PERFORM nextval('attempts'); RETURN NEW; END $f$;
    CREATE TRIGGER aaa_count_attempt BEFORE INSERT ON system_settings FOR EACH ROW EXECUTE FUNCTION count_attempt();
    INSERT INTO system_settings VALUES ('payment_new_purchase_channel','{"channel":"stripe","version":1}');`);
  // No JWTs: this isolated test-only server exposes only synthetic rows as service_role.
  docker(['run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://postgres@${db}:5432/fixture`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', POSTGREST_IMAGE]);
  let url = `http://127.0.0.1:${docker(['port', rest, '3000']).split(':').at(-1)}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const row = (version, channel = 'waffo') => ({ key: 'payment_new_purchase_channel', value: { channel, version } });
  const write = async (rows, timeout = 2000) => {
    const start = performance.now();
    const response = await fetch(`${url}/system_settings?on_conflict=key`, { method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(rows), signal: AbortSignal.timeout(timeout) });
    return { status: response.status, body: await response.json(), ms: Math.round(performance.now() - start) };
  };
  const before = Number(sql('SELECT last_value FROM attempts'));
  await assert.rejects(write(row(1), 1000), error => error.name === 'TimeoutError');
  const attempts = Number(sql('SELECT last_value FROM attempts')) - before;
  assert.ok(attempts > 1, 'one HTTP request must reproduce repeated database transactions');
  report.before = { result: 'timeout after 1000ms', attempts };
  // Stop only our disposable REST process; aborting HTTP does not necessarily stop server-side retries.
  docker(['stop', '-t', '1', rest]);
  sql(migration); sql(migration);
  docker(['start', rest]);
  url = `http://127.0.0.1:${docker(['port', rest, '3000']).split(':').at(-1)}`;
  await new Promise(resolve => setTimeout(resolve, 1000));
  const fixedBefore = Number(sql('SELECT last_value FROM attempts'));
  const stale = await write(row(1));
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'PT409');
  assert.equal(Number(sql('SELECT last_value FROM attempts')) - fixedBefore, 1);
  assert.ok(stale.ms < 1000);
  report.after = { status: stale.status, ms: stale.ms, attempts: 1 };
  const results = await Promise.all(Array.from({ length: 12 }, () => write(row(2))));
  assert.equal(results.filter(r => r.status >= 200 && r.status < 300).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.status === 409 && r.body.code === 'PT409').length, 11);
  assert.equal(sql("SELECT value->>'version' FROM system_settings WHERE key='payment_new_purchase_channel'"), '2');
  report.concurrent = { successes: 1, conflicts: 11, maxMs: Math.max(...results.map(r => r.ms)) };
  const batch = await write([{ key: 'batch_fixture', value: 'must roll back' }, row(2)]);
  assert.equal(batch.status, 409);
  assert.equal(sql("SELECT count(*) FROM system_settings WHERE key='batch_fixture'"), '0');
  report.atomicBatch = 'PASS';
} catch (error) {
  try { console.error(docker(['logs', rest])); } catch { /* absent */ }
  throw error;
} finally {
  for (const name of [rest, db]) { try { docker(['rm', '-f', '-v', name]); } catch { /* startup may have failed */ } }
  try { docker(['network', 'rm', tag]); } catch { /* startup may have failed */ }
}
console.log(JSON.stringify(report, null, 2));
