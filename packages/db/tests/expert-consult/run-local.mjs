/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only EXPERT-CONSULT (0281) verification: eligibility, one request at a time, client denial,
// account erasure of the stored contact details, idempotent reapplication and rollback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { rpc, closeAccount } from '../erasure-b2a/cases.mjs';
import { recordLibraryProof } from '../erasure-completion/library-proof.mjs';

const migrationPath = 'packages/db/migrations/0281_expert_consult_requests.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0281', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const failure = (promise) => promise.then(() => null, e => e.message);
const NEED = '想请专家看看我的账号定位和变现路径';
const CONTACT = 'wechat: CONTACT_CANARY';
const request = (actor, need = NEED, contact = CONTACT, source = 'report', client = c) =>
  client.query('SELECT expert_consult_request($1,$2,$3,$4) v', [actor, need, contact, source]).then(r => r.rows[0].v);
const state = actor => v('SELECT expert_consult_state($1) v', [actor]);
const consults = actor => v("SELECT count(*)::int v FROM tickets WHERE user_id=$1 AND category='consult'", [actor]);
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const applied = await v(catalogSql);
  await c.query(read('packages/db/tests/expert-consult/rollback.sql'));
  const rolledBack = await v(catalogSql);
  assert.notDeepEqual(rolledBack, applied);
  assert.equal(await v("SELECT count(*)::int v FROM pg_proc WHERE proname LIKE 'expert_consult_%'"), 0);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), applied);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), applied);
  report.checks.push('rollback removes only the 0281 functions; reapplying 0281 once and twice gives the same catalog');

  for (const role of ['anon', 'authenticated']) {
    for (const f of ['expert_consult_state(uuid)', 'expert_consult_request(uuid,text,text,text)', 'expert_consult_pending(uuid)']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','expert_consult_request(uuid,text,text,text)','execute') v"), true);
  assert.equal(await v("SELECT has_function_privilege('service_role','expert_consult_state(uuid)','execute') v"), true);
  assert.equal(await v("SELECT has_function_privilege('service_role','expert_consult_pending(uuid)','execute') v"), false);
  report.checks.push('clients cannot call the request functions; service_role can call state and request only');

  await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
  const actor = () => v('SELECT ws_test.actor() v');
  const positioned = async () => {
    const a = await actor();
    await v('SELECT ws_test.positioning($1,$2,$3,$4) v', [a, '测试业务', 'CANARY', true]);
    return a;
  };
  const [none, draftOnly] = [await actor(), await actor()];
  await v('SELECT ws_test.positioning($1,$2,$3,$4) v', [draftOnly, '测试业务', 'CANARY', false]);
  for (const who of [none, draftOnly]) {
    assert.deepEqual(await state(who), { eligible: false, pending: null });
    assert.equal(await failure(request(who)), 'EXPERT_CONSULT_NOT_ELIGIBLE');
    assert.equal(await consults(who), 0);
  }
  report.checks.push('deny: no positioning, unconfirmed draft only (same rule as POSITIONING-GATE 0219); nothing stored');

  const user = await positioned();
  assert.deepEqual(await state(user), { eligible: true, pending: null });
  for (const [need, contact, source] of [['短', CONTACT, 'report'], [NEED, 'ab', 'report'], [NEED, CONTACT, 'checkout'],
    [null, CONTACT, 'report'], [NEED, null, 'report'], [NEED, CONTACT, null], ['x'.repeat(2001), CONTACT, 'report'],
    [NEED, 'x'.repeat(201), 'report'], ['          ', CONTACT, 'report']]) {
    assert.equal(await failure(request(user, need, contact, source)), 'EXPERT_CONSULT_INVALID', JSON.stringify([need, contact, source]));
  }
  assert.equal(await consults(user), 0);
  report.checks.push('deny: too short or too long need/contact, blank text, unknown entry; nothing stored');

  const first = await request(user, `  ${NEED}  `, ` ${CONTACT} `, 'pricing');
  assert.equal(first.created, true);
  const row = (await c.query('SELECT * FROM tickets WHERE id=$1', [first.ticketId])).rows[0];
  assert.equal(row.user_id, user); assert.equal(row.category, 'consult'); assert.equal(row.status, 'open');
  assert.equal(row.title, '专家诊断预约'); assert.equal(row.priority, 'high'); assert.deepEqual(row.attachments, []);
  assert.equal(row.description, `需求：\n${NEED}\n\n联系方式：${CONTACT}\n\n入口：价格页`);
  assert.doesNotMatch(row.description, /\$|价格：|报价/);
  const again = await request(user, NEED, 'other contact', 'studio');
  assert.deepEqual(again, { ...first, created: false });
  assert.equal(await consults(user), 1);
  assert.equal((await state(user)).pending.ticketId, first.ticketId);
  // The user may close their own ticket; a new request still waits 24 hours after the last one.
  await c.query("UPDATE tickets SET status='closed' WHERE id=$1", [first.ticketId]);
  assert.equal((await request(user)).created, false);
  await c.query("UPDATE tickets SET created_at=now()-interval '25 hours' WHERE id=$1", [first.ticketId]);
  assert.equal((await state(user)).pending, null);
  const second = await request(user, NEED, CONTACT, 'studio');
  assert.equal(second.created, true);
  assert.match(await v('SELECT description v FROM tickets WHERE id=$1', [second.ticketId]), /入口：工作室版联系入口$/);
  // An open request stays the pending one however old it is; the Owner closes it after following up.
  await c.query("UPDATE tickets SET created_at=now()-interval '30 days' WHERE id=$1", [second.ticketId]);
  assert.equal((await request(user)).ticketId, second.ticketId);
  report.checks.push('allow: one request with trimmed text and its entry; repeat answers the open one or any from the last 24 hours');

  const racer = await positioned();
  const clients = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
  await Promise.all(clients.map(x => x.connect()));
  try {
    const results = await Promise.all(clients.map(x => request(racer, NEED, CONTACT, 'report', x)));
    assert.deepEqual(results.map(r => r.created).sort(), [false, true]);
    assert.equal(results[0].ticketId, results[1].ticketId);
  } finally { await Promise.all(clients.map(x => x.end())); }
  assert.equal(await consults(racer), 1);
  report.checks.push('two concurrent submissions create one request');

  // Clients keep their own category list: a direct insert of a consult ticket is refused by RLS.
  const direct = await positioned();
  await c.query('BEGIN');
  try {
    await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: direct, role: 'authenticated' })]);
    await c.query('SET LOCAL ROLE authenticated');
    assert.match(await failure(c.query("INSERT INTO tickets(user_id,title,description,category) VALUES($1,'专家诊断预约','x','consult')",
      [direct])), /row-level security/);
  } finally { await c.query('ROLLBACK'); }
  report.checks.push('deny: a client inserting a consult ticket directly');

  const suspended = await positioned();
  await c.query("UPDATE profiles SET status='suspended' WHERE id=$1", [suspended]);
  assert.equal(await failure(request(suspended)), 'EXPERT_CONSULT_ACCOUNT_CLOSED');
  assert.equal(await failure(state(suspended)), 'EXPERT_CONSULT_ACCOUNT_CLOSED');
  assert.equal(await failure(request(randomUUID())), 'EXPERT_CONSULT_ACCOUNT_CLOSED');

  // Account erasure: a closing account cannot ask, and cleanup deletes the stored need and contact details.
  const erased = await positioned();
  const asked = await request(erased);
  await c.query("INSERT INTO ticket_replies(ticket_id,user_id,content,is_admin) VALUES($1,$2,'已收到','true')", [asked.ticketId, user]);
  await closeAccount(c, { actor: erased });
  assert.equal(await failure(request(erased)), 'EXPERT_CONSULT_ACCOUNT_CLOSED');
  assert.equal(await failure(state(erased)), 'EXPERT_CONSULT_ACCOUNT_CLOSED');
  // Rolling back while a closing account still has a request refuses, and changes nothing.
  assert.equal(await failure(c.query(read('packages/db/tests/expert-consult/rollback.sql'))), 'EXPERT_CONSULT_ROLLBACK_ERASURE_PENDING');
  await c.query('ROLLBACK');
  assert.equal(await v("SELECT count(*)::int v FROM pg_proc WHERE proname LIKE 'expert_consult_%'"), 3);
  assert.equal(await v("SELECT category v FROM tickets WHERE id=$1", [asked.ticketId]), 'consult');
  await recordLibraryProof(c, { actor: erased });
  let cleaned;
  for (let i = 0; i < 5; i++) {
    cleaned = await rpc(c, 'account_erasure_local_cleanup', erased, true);
    if (await v('SELECT count(*)::int v FROM tickets WHERE id=$1', [asked.ticketId]) === 0) break;
  }
  assert.equal(await v('SELECT count(*)::int v FROM tickets WHERE id=$1', [asked.ticketId]), 0);
  assert.equal(await v('SELECT count(*)::int v FROM ticket_replies WHERE ticket_id=$1', [asked.ticketId]), 0);
  assert.equal(await v("SELECT count(*)::int v FROM tickets WHERE description LIKE '%'||$1||'%' AND user_id=$2", ['CONTACT_CANARY', erased]), 0);
  // Other leaves (the positioning fixture's own content) are cleared by their own erasure stages.
  assert.deepEqual(cleaned.errors, []);
  assert.equal(await v('SELECT count(*)::int v FROM tickets WHERE user_id=$1', [erased]), 0);
  report.checks.push('deny: suspended, missing and closing accounts; erasure deletes the request, its replies and contact details');

  // Rollback with data: every request is kept as a 'question' ticket an older build can show, nothing is deleted.
  const kept = Number(await v("SELECT count(*)::int v FROM tickets WHERE category='consult'"));
  assert.ok(kept >= 3);
  await c.query(read('packages/db/tests/expert-consult/rollback.sql'));
  assert.equal(await v("SELECT count(*)::int v FROM tickets WHERE category='consult'"), 0);
  assert.equal(await v("SELECT count(*)::int v FROM tickets WHERE category='question' AND title='专家诊断预约'"
    + " AND description LIKE '%联系方式：%'"), kept);
  assert.equal(await v("SELECT category v FROM tickets WHERE id=$1", [second.ticketId]), 'question');
  assert.equal(await v("SELECT count(*)::int v FROM pg_proc WHERE proname LIKE 'expert_consult_%'"), 0);
  report.checks.push('rollback refuses while a closing account has a request; otherwise keeps every request as a question ticket');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
