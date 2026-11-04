/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only check of migration 9999 (refusals answered, not re-run): each of the seven functions refuses out-of-date input through
// the repository's pinned PostgREST. With the old SQLSTATE 40001 one HTTP request hangs while the database re-runs the call; with
// PT409 the same request is answered at once with 409, after a single run. Synthetic rows only; no remote host or credentials.
// Run: node packages/db/tests/refusal-codes/rest-local.mjs --local-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';
import { POSTGREST_IMAGE } from '../v3/images.mjs';

const migration = read('packages/db/migrations/9999_refusals_no_postgrest_retry.sql');
const run = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
const ok = r => { if (r.status !== 0 || r.error) throw new Error((r.stderr || String(r.error)).slice(-3000)); return r.stdout.trim(); };
const endpoint = ok(run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'), 'only the local Docker socket');
const docker = args => ok(run(['--host', endpoint, ...args]));
ok(run(['--host', endpoint, 'image', 'inspect', POSTGREST_IMAGE]));

const tag = `graylum-refusal-${randomUUID().slice(0, 8)}`, rest = `${tag}-rest`;
docker(['network', 'create', tag]);
const report = { checks: [] };
let db;
try {
  db = await localDb({ dockerArgs: ['--network', tag, '--network-alias', 'refusaldb'] });
  report.build = db.build;
  const c = db.client;
  const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;

  // Fixtures: one active member per case, rows written with triggers and foreign keys off (only the refusal is under test).
  const member = async () => { const a = randomUUID(); await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]); return a; };
  const raw = async (sql, args) => {
    await c.query('SET session_replication_role=replica');
    try { return (await c.query(sql, args)).rows[0]; } finally { await c.query('RESET session_replication_role'); }
  };
  const session = async a => (await raw(`INSERT INTO runtime_sessions(id,actor_id,start_request_id,start_payload,scope) VALUES(gen_random_uuid(),$1,gen_random_uuid(),'{}',
    '{"kind":"positioning_draft"}') RETURNING id`, [a])).id;
  const job = async (a, state, results = {}) => (await raw(`INSERT INTO social_publish_jobs(actor_id,business_id,idempotency_key,
    request_fingerprint,targets,state,results) VALUES($1,gen_random_uuid(),$2,repeat('a',64),'[{"connectionId":"c1"}]',$3,$4)
    RETURNING id`, [a, `refusal-${randomUUID()}`, state, JSON.stringify(results)])).id;
  const admin = await member();
  await c.query("UPDATE profiles SET role='admin' WHERE id=$1", [admin]);

  const cases = [];
  const add = (name, refusal, fn, args) => cases.push({ name, refusal, fn, args });
  // Content erasure: a real preview, then a new turn in the conversation (the preview is out of date). Its own phases below.
  const erasure = async () => {
    const a = await member(), s = await session(a);
    const { previewHash } = await v("SELECT content_erasure_preview($1,'session',$2) v", [a, s]);
    const turn = (await raw(`INSERT INTO turns(actor_id,session_id,request_id,kind,state) VALUES($1,$2,gen_random_uuid(),'chat',
      'running') RETURNING id`, [a, s])).id;
    return { s, turn, args: { a, k: 'session', target: s, expected_hash: previewHash } };
  };
  const intact = async s => Number(await v(`SELECT count(*) v FROM runtime_sessions WHERE id=$1 AND content_deleted_at IS NULL
    AND erased_at IS NULL`, [s])) === 1;
  const erasures = { before: await erasure(), after: await erasure() };
  add('content_erasure_confirm', 'CONTENT_ERASURE_PREVIEW_CHANGED', 'content_erasure_confirm', erasures.after.args);
  {
    const a = await member(), s = await session(a), family = randomUUID();
    await raw(`INSERT INTO runtime_session_results(id,actor_id,session_id,family_id,version,result_type,title,body,request_id)
      VALUES($1,$2,$3,$1,1,'script','t','b',gen_random_uuid())`, [family, a, s]);
    add('runtime_session_result_edit', 'SESSION_RESULT_VERSION_CONFLICT', 'runtime_session_result_edit',
      { p_actor_id: a, p_family_id: family, p_request_id: randomUUID(), p_expected_version: 7, p_title: 'x', p_body: 'y' });
  }
  add('billing_provider_prices_swap', 'BILLING_UNIT_PROVIDER_PRICES_CONFLICT', 'billing_provider_prices_swap',
    { p_expected_hash: 'c'.repeat(64), p_value: '{}' });
  {
    const pkg = (await raw(`INSERT INTO credit_packages(name,price,credits_amount) VALUES('refusal',1,1) RETURNING id`)).id;
    add('pay_common_save_catalog', 'PAY_COMMON_CATALOG_CONFLICT', 'pay_common_save_catalog',
      { p_kind: 'credit_package', p_id: pkg, p_values: { name: 'renamed' }, p_prices: {}, p_merchant_namespace: null,
        p_payment_mode: null, p_expected_level: 'gold' });
  }
  add('publish_monitor_publish_release', 'PUBLISH_MONITOR_STATE_CONFLICT', 'publish_monitor_publish_release',
    { p_job: await job(await member(), 'completed', { c1: { status: 'published' } }), p_code: 'TEST_RELEASE' });
  add('publish_monitor_publish_record', 'PUBLISH_MONITOR_STATE_CONFLICT', 'publish_monitor_publish_record',
    { p_job: await job(await member(), 'claimed'), p_provider_post_id: null, p_results: {} });
  add('publish_monitor_publish_manual_resolve', 'PUBLISH_MONITOR_STATE_CONFLICT', 'publish_monitor_publish_manual_resolve',
    { p_admin: admin, p_job: await job(await member(), 'completed', { c1: { status: 'published' } }), p_not_sent: true, p_results: {} });

  // Each run of a function adds one to its own sequence; a rolled-back run keeps its number (sequences are not transactional).
  for (const { fn } of cases) await c.query(`CREATE SEQUENCE public.attempts_${fn}`);
  const definitions = new Map();
  for (const { fn } of cases) {
    const text = await v(`SELECT pg_get_functiondef(p.oid) v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1`, [fn]);
    assert.doesNotMatch(text, /'40001'/, `${fn} still raises 40001 after the migration`);
    assert.match(text, /ERRCODE='PT409'/, fn);
    definitions.set(fn, text);
  }
  // Test-only copies: the counter added after BEGIN, and (for "before") the old 40001 put back in place of PT409.
  const install = async old => {
    for (const [fn, text] of definitions) {
      const counted = text.replace(/\nBEGIN\n/, `\nBEGIN\n PERFORM nextval('public.attempts_${fn}');\n`);
      assert.notEqual(counted, text, fn);
      await c.query(old ? counted.replaceAll("ERRCODE='PT409'", "ERRCODE='40001'") : counted);
    }
  };
  const attempts = async fn => Number(await v(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END v FROM public.attempts_${fn}`));

  let url;
  const startRest = async () => {
    try { docker(['rm', '-f', rest]); } catch { /* not running yet */ }
    // No JWTs: this disposable server reaches only the synthetic database, as the server role the API uses.
    docker(['run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
      '-e', 'PGRST_DB_URI=postgres://postgres@refusaldb:5432/perf', '-e', 'PGRST_DB_SCHEMAS=public',
      '-e', 'PGRST_DB_ANON_ROLE=service_role', POSTGREST_IMAGE]);
    url = `http://127.0.0.1:${docker(['port', rest, '3000']).split(':').at(-1)}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('PostgREST did not start');
  };
  const call = async (fn, args, timeout) => {
    const start = performance.now();
    const response = await fetch(`${url}/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(timeout) });
    return { status: response.status, body: await response.json(), ms: Math.round(performance.now() - start) };
  };

  // Before: one request is not answered within a second, while the database runs the call again and again.
  await install(true);
  await startRest();
  report.before = {};
  for (const { name, fn, args } of cases) {
    const from = await attempts(fn);
    await assert.rejects(call(fn, args, 1000), error => error.name === 'TimeoutError', `${name} answered with 40001`);
    const runs = await attempts(fn) - from;
    assert.ok(runs > 1, `${name}: one request must show repeated runs, got ${runs}`);
    report.before[name] = { result: 'no answer within 1000ms', runs };
  }
  // The irreversible case: the user confirms an out-of-date preview and sees no answer; once the conversation is back to what was
  // previewed (the new turn removed), a re-run that is still going goes through and deletes it after the fact.
  {
    const { s, turn, args } = erasures.before;
    const pending = call('content_erasure_confirm', args, 10000);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(await intact(s));
    await c.query('DELETE FROM turns WHERE id=$1', [turn]);
    const late = await pending;
    assert.equal(late.status, 200, JSON.stringify(late));
    assert.equal(await intact(s), false, 'with 40001 the stale confirmation deletes the conversation later');
    report.before.erasureAfterTheFact = { status: late.status, ms: late.ms, deleted: true };
  }
  // Aborting the HTTP request does not stop PostgREST's re-runs: stop the disposable server before the next phase.
  docker(['rm', '-f', rest]);
  report.checks.push('with 40001 every one of the seven requests hangs and the database re-runs it');

  // After: the same requests are refused at once, with the refusal's own message, after one run.
  await install(false);
  await startRest();
  report.after = {};
  for (const { name, refusal, fn, args } of cases) {
    const from = await attempts(fn);
    const answer = await call(fn, args, 5000);
    assert.equal(answer.status, 409, `${name}: ${JSON.stringify(answer)}`);
    assert.equal(answer.body.code, 'PT409', name);
    assert.equal(answer.body.message, refusal, name);
    assert.equal(await attempts(fn) - from, 1, `${name} ran more than once`);
    assert.ok(answer.ms < 1000, `${name} took ${answer.ms}ms`);
    report.after[name] = { status: 409, ms: answer.ms, runs: 1 };
  }
  report.checks.push('with PT409 each request is answered 409 with its refusal message after one run, under a second');
  {
    // The refused erasure stays refused: the conversation going back to what was previewed deletes nothing.
    const { s, turn } = erasures.after;
    await c.query('DELETE FROM turns WHERE id=$1', [turn]);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.ok(await intact(s), 'a refused erasure must never run later');
    report.after.erasureAfterTheFact = { deleted: false };
  }
  report.checks.push('content erasure: preview out of date -> 409 at once, and nothing is deleted afterwards');

  // The migration itself (no counter), applied twice: same answers, nothing else changed (grants included).
  const grants = async () => v(`SELECT jsonb_object_agg(p.proname,coalesce(p.proacl::text,'')) v FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1)`, [cases.map(x => x.fn)]);
  const before = await grants();
  await c.query(migration); await c.query(migration);
  assert.deepEqual(await grants(), before);
  for (const [fn, text] of definitions) assert.equal(await v(`SELECT pg_get_functiondef(p.oid) v FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [fn]), text, fn);
  // (The erasure's conversation is back to its preview by now, so that confirmation would rightly go through: left out.)
  for (const { name, fn, args } of cases.filter(x => x.fn !== 'content_erasure_confirm')) {
    const answer = await call(fn, args, 5000);
    assert.equal(answer.status, 409, name);
  }
  report.checks.push('the migration re-applies cleanly, keeps every grant and answers the same 409s');
} catch (error) {
  report.failed = String(error.stack ?? error);
  process.exitCode = 1;
  try { report.restLogs = docker(['logs', '--tail', '40', rest]); } catch { /* not started */ }
} finally {
  try { docker(['rm', '-f', rest]); } catch { /* not started */ }
  await db?.close();
  try { docker(['network', 'rm', tag]); } catch { /* still in use */ }
  console.log(JSON.stringify(report, null, 2));
}
