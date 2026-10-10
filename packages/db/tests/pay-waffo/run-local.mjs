/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { admissionCases } from './admission.mjs';
import { retentionCases } from './retention.mjs';
import { sourceCases } from './sources.mjs';
import { scopeCases } from './scopes.mjs';
import { invoiceCases } from './invoices.mjs';
import { catalogCases } from './catalog.mjs';
import { refundCases } from './refunds.mjs';
import { POSTGRES_IMAGE } from '../v3/images.mjs';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const name = `graylum-waffo-${randomUUID().slice(0, 8)}`;
const command = (argv, input) => {
  const r = spawnSync('docker', argv, { input, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error(r.stderr || String(r.error));
  return r.stdout.trim();
};
const endpoint = command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.ok(endpoint.startsWith('unix:///'), 'local Docker only');
const docker = (argv, input) => command(['--host', endpoint, ...argv], input);
const sql = input => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-X', '-qAt', '-U', 'postgres', '-d', 'waffo',
  '-v', 'ON_ERROR_STOP=1', '-f', '/dev/stdin'], input);
const clients = [];
try {
  docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=local-test-only', '-e', 'POSTGRES_DB=waffo',
    '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  for (let attempt = 0; attempt < 50; attempt++) {
    try { sql('SELECT 1'); break; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  installPgCronStub(root, name, (argv, input) => docker(['exec', ...argv], input));
  const apply = input => { try { sql(input); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } };
  const fingerprint = () => JSON.parse(sql(readFileSync(resolve(root, 'packages/db/tests/baseline/fingerprint.sql'), 'utf8')));
  const report = buildFromFiles(root, {
    applyFile: path => apply(readFileSync(resolve(root, path), 'utf8')), applyServerOnly: apply, fingerprint: process.argv.includes('--quick') ? undefined : fingerprint,
  });
  assert.equal(report.failed, null, JSON.stringify(report));
  const before = fingerprint();
  sql(readFileSync(resolve(root, 'packages/db/migrations/0204_pay_waffo_qualification.sql'),'utf8'));
  assert.deepEqual(fingerprint(),before,'new migration repeat preserves structure');
  for (const file of ['purchase-admission','checkout-persistence','catalog-write','membership-facts',
    'invoice-grant','annual-grant','upgrade','invoice-lifecycle']) {
    sql(readFileSync(resolve(root, `packages/db/tests/pay-common/${file}.sql`),'utf8'));
  }
  const port = Number(docker(['port', name, '5432/tcp']).split(':').at(-1));
  const connect = async () => {
    const c = new pg.Client({ host: '127.0.0.1', port, database: 'waffo', user: 'postgres', password: 'local-test-only', statement_timeout: 15000 });
    clients.push(c); await c.connect(); return c;
  };
  const admin = await connect();
  const service = await connect();
  await service.query('SET ROLE service_role');
  const receive = (mode, type='subscription.payment_succeeded', digest='a'.repeat(64)) => service.query(
    'SELECT pay_waffo_receive_event($1,$2,$3,$4,$5,$6) AS id', ['fixture',mode,type,'event-1',digest,{paymentId:'payment-1',subscriptionId:'subscription-1'}]);
  const first = (await receive('test')).rows[0].id;
  assert.deepEqual((await service.query('SELECT resource_refs FROM waffo_event_receipts WHERE id=$1',[first])).rows[0].resource_refs,
    {paymentId:'payment-1',subscriptionId:'subscription-1'});
  await assert.rejects(()=>service.query('SELECT pay_waffo_receive_event($1,$2,$3,$4,$5,$6)',
    ['fixture','test','order.completed','invalid','a'.repeat(64),{email:'private@example.invalid'}]),/RESOURCE_INVALID/);
  assert.equal((await receive('test')).rows[0].id, first);
  assert.notEqual((await receive('live')).rows[0].id, first);
  assert.notEqual((await receive('test','refund.succeeded')).rows[0].id, first);
  await assert.rejects(()=>receive('test','subscription.payment_succeeded','b'.repeat(64)), /EVENT_CONFLICT/);
  for (const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>receive('test'),/permission denied/);
    await assert.rejects(()=>service.query('SELECT * FROM waffo_event_receipts'),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  const scopedCases=await scopeCases({admin});
  scopedCases.push(...await invoiceCases({admin}));
  const routes = {version:1,card:{enabled:false},wechat_pay:{enabled:false,annualVerified:false},
    alipay:{enabled:false,annualVerified:false}};
  await admin.query("INSERT INTO system_settings(key,value) VALUES('payment_method_routes',$1)",[routes]);
  await assert.rejects(()=>admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[routes]),
    /VERSION_CONFLICT/);
  await assert.rejects(()=>admin.query("DELETE FROM system_settings WHERE key='payment_method_routes'"),/DELETE_DENIED/);
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[{...routes,version:2}]);
  const cases = await admissionCases({admin,service,connect});
  cases.push(...await retentionCases({admin,service}));
  cases.push(...await sourceCases({admin}));
  cases.push(...await catalogCases({admin,service}));
  cases.push(...await refundCases({admin,service,connect}));
  console.log(JSON.stringify({result:'PASS',replay:report,
    cases:['event-idempotency','event-conflict','test-live-isolation','refund-event-not-payment-dedup',
      'service-only-receipt','durable-lookup-refs-no-contact-data','route-version-cas','route-delete-denied',...scopedCases,...cases]}));
} finally {
  await Promise.all(clients.map(c=>c.query('ROLLBACK').catch(()=>{})));
  await Promise.all(clients.map(c=>c.end()));
  try {docker(['rm','-f',name]);} catch { /* preserve original failure */ }
}
