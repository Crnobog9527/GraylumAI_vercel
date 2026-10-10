/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { calendarCases } from './calendar.mjs';
import { upgradeCases } from './upgrade.mjs';
import { transitionCases } from './transitions.mjs';
import { controlCases } from './controls.mjs';
import { deliveryCases } from './delivery.mjs';
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
  sql(readFileSync(resolve(root, 'packages/db/migrations/0210_pay_waffo_delivery.sql'),'utf8'));
  assert.deepEqual(fingerprint(),before,'new migration repeat preserves structure');
  const port = Number(docker(['port', name, '5432/tcp']).split(':').at(-1));
  const connect = async () => {
    const c = new pg.Client({ host: '127.0.0.1', port, database: 'waffo', user: 'postgres', password: 'local-test-only', statement_timeout: 15000 });
    clients.push(c); await c.connect(); return c;
  };
  const admin = await connect();
  const service = await connect();
  await service.query('SET ROLE service_role');
  const cases = await deliveryCases({admin,service,connect});
  await service.query('SET ROLE service_role');
  cases.push(...await transitionCases({admin,service}));
  cases.push(...await upgradeCases({admin,service}));
  cases.push(...await calendarCases({admin,service}));
  cases.push(...await controlCases({admin,service}));
  console.log(JSON.stringify({result:'PASS',replay:report,cases}));
} finally {
  await Promise.all(clients.map(c=>c.query('ROLLBACK').catch(()=>{})));
  await Promise.all(clients.map(c=>c.end()));
  try {docker(['rm','-f',name]);} catch { /* preserve original failure */ }
}
