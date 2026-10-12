/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only DATA-ERASURE 0226 verification: our own log tables keep at most 30 days (E7).
import assert from 'node:assert/strict';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0226_log_retention_cleanup.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0226', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const count = (table, extra = '') => v(`SELECT count(*)::int v FROM ${table} ${extra}`);
const cleanup = async (limit) => {
  await c.query('SET ROLE service_role');
  try { return await v(`SELECT log_retention_cleanup(${limit ?? ''}) v`); } finally { await c.query('RESET ROLE'); }
};
const ages = ['31 days', '29 days 1 hour', '28 days 23 hours', '1 hour'];

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0226 reapplication after the full chain preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    assert.equal(await v("SELECT has_function_privilege($1,'log_retention_cleanup(integer)','execute') v", [role]), false);
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','log_retention_cleanup(integer)','execute') v"), true);
  report.checks.push('only service_role can run the cleanup');

  for (const age of ages) {
    await c.query(`INSERT INTO application_logs(level,category,message,created_at) VALUES('info','system','fixture',now()-$1::interval)`, [age]);
    await c.query(`INSERT INTO diagnostic_results(test_id,test_name,category,status,created_at)
      VALUES('fixture','fixture','ai','passed',now()-$1::interval)`, [age]);
    await c.query(`INSERT INTO scheduled_job_runs(job_key,started_at,created_at) VALUES('job_a',now()-$1::interval,now()-$1::interval)`, [age]);
  }
  // A job that has not finished for 40 days keeps its newest finished run (library cleanup resumes from its
  // summary) and its newest run, even when that newest run is an abandoned 'running' row.
  await c.query(`INSERT INTO scheduled_job_runs(job_key,started_at,finished_at,status,summary) VALUES
    ('job_b',now()-interval '45 days',now()-interval '45 days','success','{}'),
    ('job_b',now()-interval '40 days',now()-interval '40 days','success','{"scanCursor":"c"}'),
    ('job_b',now()-interval '35 days',NULL,'running','{}')`);
  const audit = await count('user_activity_logs');
  await c.query(`INSERT INTO user_activity_logs(action,action_type,created_at) VALUES('fixture','credit_adjustment',now()-interval '90 days')`);

  const result = await cleanup();
  assert.deepEqual(result, { applicationLogs: 2, diagnosticResults: 2, scheduledJobRuns: 3, more: false });
  for (const table of ['application_logs', 'diagnostic_results']) {
    assert.equal(await count(table, "WHERE created_at<now()-interval '29 days'"), 0, table);
    assert.equal(await count(table, "WHERE created_at>=now()-interval '29 days'"), 2, table);
  }
  assert.equal(await count('scheduled_job_runs', "WHERE job_key='job_a'"), 2);
  assert.deepEqual((await c.query("SELECT status,summary FROM scheduled_job_runs WHERE job_key='job_b' ORDER BY started_at")).rows,
    [{ status: 'success', summary: { scanCursor: 'c' } }, { status: 'running', summary: {} }]);
  assert.equal(await count('user_activity_logs'), audit + 1, 'admin audit is not touched');
  report.checks.push('deletes rows older than 29 days, keeps newer rows, the newest run of each job and admin audit');

  assert.deepEqual(await cleanup(), { applicationLogs: 0, diagnosticResults: 0, scheduledJobRuns: 0, more: false });
  report.checks.push('repeat run is a no-op');

  for (let i = 0; i < 5; i++) {
    await c.query(`INSERT INTO application_logs(level,category,message,created_at) VALUES('info','system','fixture',now()-interval '40 days')`);
  }
  assert.equal((await cleanup(3)).more, true);
  assert.equal((await cleanup(3)).applicationLogs, 2);
  await assert.rejects(cleanup(0), /LOG_RETENTION_LIMIT_INVALID/);
  report.checks.push('bounded batches report more work; invalid limits are rejected');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
