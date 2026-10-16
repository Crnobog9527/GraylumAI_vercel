/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PAY-NOTIFY PR-N1 verification: grants, the once-only send state machine (enqueue, claim,
// finish, hold), the 24-hour same-key window, admin resend and audit, account erasure, the 'resend'
// secret slot, and repeatable application on the full chain.
// Run: node packages/db/tests/payment-notices/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migration = readdirSync(new URL('../../migrations/', import.meta.url)).filter(f => f.endsWith('_payment_notices.sql'));
assert.equal(migration.length, 1);
const migrationPath = `packages/db/migrations/${migration[0]}`;
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: migration[0], checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => {
  const e = await promise.then(() => null, error => error);
  assert.equal(e?.code, expected, e?.message);
};
const profile = async (role = 'user', email = null) => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits,role,email) VALUES($1,0,$2,$3)', [id, role, email]);
  return id;
};
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64);
const enqueue = (user, ref = randomUUID(), due = '2027-03-01:-7d', client = c) =>
  v("SELECT payment_notice_enqueue($1,'wallet_founder_expiry',$2,$3,'{\"endDate\":\"2027-03-01\"}') v", [user, ref, due], client);
const claim = (id, digest = D1, actor = null, client = c) =>
  v("SELECT payment_notice_claim($1,$2,'v1',$3) v", [id, digest, actor], client);
const finish = (id, attempt, outcome, msg = null, err = null) =>
  v('SELECT payment_notice_finish($1,$2,$3,$4,$5) v', [id, attempt, outcome, msg, err]);
const row = async id => (await c.query('SELECT * FROM payment_notices WHERE id=$1', [id])).rows[0];
const FUNCTIONS = ['payment_notice_enqueue(uuid,text,text,text,jsonb)', 'payment_notice_prepare(uuid)',
  'payment_notice_claim(uuid,text,text,uuid)', 'payment_notice_finish(uuid,integer,text,text,text)',
  'payment_notice_hold(uuid,text,text)', 'payment_notice_admin_list(uuid)'];

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  await c.query(read('packages/db/migrations/0259_platform_secrets.sql'));
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('reapplying the migration (also after re-running 0259) keeps the complete catalog');

  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await v('SELECT has_table_privilege($1,$2,$3) v', [role, 'public.payment_notices', p]), false, `${role} ${p}`);
    }
    for (const f of [...FUNCTIONS, 'payment_notice_resendable(payment_notices)']) {
      const expected = role === 'service_role' && !f.startsWith('payment_notice_resendable');
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), expected, `${role} ${f}`);
    }
  }
  report.checks.push('only service_role calls the six entry points; nobody but postgres touches the table');

  const [admin, user, other] = [await profile('admin', 'admin@example.test'), await profile('user', 'u@example.test'),
    await profile('user', 'o@example.test')];
  await c.query('SET ROLE service_role');
  const ref = randomUUID();
  const first = await enqueue(user, ref);
  assert.equal(first.created, true);
  assert.deepEqual(await enqueue(user, ref), { ...first, created: true });
  await code(enqueue(other, ref), '23514');
  await code(v("SELECT payment_notice_enqueue($1,'marketing',$2,'x') v", [user, randomUUID()]), '23514');
  const prepared = await v('SELECT payment_notice_prepare($1) v', [first.id]);
  assert.equal(prepared.email, 'u@example.test');
  assert.equal(prepared.erasing, false);
  report.checks.push('enqueue is idempotent per (kind, source, due), refuses another owner and unknown kinds');

  const second = new (c.constructor)({ host: c.host, port: c.port, user: 'postgres', database: c.database });
  await second.connect();
  await second.query('SET ROLE service_role');
  const parallelRef = randomUUID();
  const both = await Promise.all([enqueue(user, parallelRef), enqueue(user, parallelRef, '2027-03-01:-7d', second)]);
  assert.equal(both[0].id, both[1].id);
  const claims = await Promise.all([claim(both[0].id), claim(both[0].id, D1, null, second)]);
  assert.deepEqual(claims.map(x => x.decision).sort(), ['busy', 'send']);
  await second.end();
  report.checks.push('two concurrent jobs share one row and only one of them may send');

  const sent = await claim(first.id);
  assert.equal(sent.decision, 'send');
  assert.equal(sent.attempt, 1);
  assert.equal((await claim(first.id)).decision, 'busy');
  await code(finish(first.id, 1, 'sent'), '23514');
  assert.equal((await finish(first.id, 1, 'sent', 'msg_1')).state, 'sent');
  assert.equal((await claim(first.id)).decision, 'done');
  await c.query('RESET ROLE');
  const r1 = await row(first.id);
  assert.equal(r1.provider_message_id, 'msg_1');
  assert.ok(r1.sent_at);
  assert.equal(r1.payload_digest, D1);
  await c.query('SET ROLE service_role');
  report.checks.push('claim -> sent records the provider id; a sent notice is never claimed again');

  const failing = (await enqueue(user)).id;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const got = await claim(failing);
    assert.equal(got.decision, 'send');
    assert.equal(got.attempt, attempt);
    assert.equal((await finish(failing, attempt, 'failed', null, 'PAYMENT_NOTICE_PROVIDER_422')).state, 'failed');
  }
  assert.equal((await claim(failing)).decision, 'done');
  report.checks.push('an explicit refusal is retried by later runs, at most three attempts in total');

  const uncertain = (await enqueue(user)).id;
  assert.equal((await claim(uncertain)).attempt, 1);
  assert.equal((await finish(uncertain, 1, 'unknown', null, 'PAYMENT_NOTICE_PROVIDER_503')).state, 'unknown');
  assert.equal((await claim(uncertain)).attempt, 2);
  // A late answer from attempt 1 cannot overwrite attempt 2, but a delivery is never lost.
  assert.equal((await finish(uncertain, 1, 'failed', null, 'X')).stale, true);
  assert.equal((await finish(uncertain, 1, 'sent', 'msg_late')).state, 'sent');
  const changed = (await enqueue(user)).id;
  await claim(changed);
  await finish(changed, 1, 'unknown');
  assert.deepEqual(await claim(changed, D2), { decision: 'manual', reason: 'digest_mismatch' });
  assert.equal((await claim(changed)).decision, 'done');
  report.checks.push('an uncertain result is retried only with the same digest; a changed mail goes to manual review');

  const crashed = (await enqueue(user)).id;
  await claim(crashed);
  await c.query('RESET ROLE');
  await c.query("UPDATE payment_notices SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [crashed]);
  await c.query('SET ROLE service_role');
  assert.equal((await claim(crashed)).attempt, 2);
  const expired = (await enqueue(user)).id;
  await claim(expired);
  await finish(expired, 1, 'unknown');
  await c.query('RESET ROLE');
  await c.query("UPDATE payment_notices SET first_attempt_at=now()-interval '25 hours' WHERE id=$1", [expired]);
  await c.query('SET ROLE service_role');
  assert.deepEqual(await claim(expired), { decision: 'manual', reason: 'unknown_expired' });
  report.checks.push('an expired lease counts as uncertain; after 24 hours nothing is resent automatically');

  const manual = (await enqueue(user)).id;
  await claim(manual);
  await finish(manual, 1, 'unknown');
  assert.equal((await finish(manual, 1, 'unresolved', null, 'PAYMENT_NOTICE_PROVIDER_503')).state, 'manual');
  assert.equal((await claim(manual)).decision, 'done');
  await code(claim(manual, D1, user), '42501');
  await code(v('SELECT payment_notice_admin_list($1) v', [user]), '42501');
  let list = await v('SELECT payment_notice_admin_list($1) v', [admin]);
  const listed = list.find(item => item.id === manual);
  assert.equal(listed.resendable, true);
  assert.equal(listed.userEmail, 'u@example.test');
  assert.equal(list.find(item => item.id === expired).resendable, false);
  assert.ok(!list.some(item => item.id === first.id), 'sent notices are not listed');
  const resent = await claim(manual, D1, admin);
  assert.equal(resent.decision, 'send');
  assert.equal(resent.attempt, 2);
  assert.equal((await finish(manual, 2, 'sent', 'msg_2')).state, 'sent');
  assert.equal((await claim(manual, D1, admin)).decision, 'refused');
  assert.equal((await claim(expired, D1, admin)).decision, 'refused');
  await c.query('RESET ROLE');
  const audit = (await c.query("SELECT admin_id,details FROM user_activity_logs WHERE action='payment_notice_resend'")).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].admin_id, admin);
  assert.doesNotMatch(JSON.stringify(audit[0].details), /@example\.test/);
  const columns = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='payment_notices'")).rows
    .map(r => r.column_name);
  assert.ok(!columns.some(name => /email|body|text|html|subject/.test(name)), columns.join(','));
  await c.query('SET ROLE service_role');
  report.checks.push('admin resend: admins only, uncertain rows within 24 hours, same key, audited without address');

  const held = (await enqueue(user)).id;
  assert.equal((await v("SELECT payment_notice_hold($1,'pending','PAYMENT_NOTICE_NOT_CONFIGURED') v", [held])).held, true);
  assert.equal((await claim(held)).decision, 'send');
  await code(v("SELECT payment_notice_hold($1,'sent','X') v", [held]), '23514');
  assert.equal((await v("SELECT payment_notice_hold($1,'skipped','X') v", [held])).held, false);
  report.checks.push('hold keeps a pending row (not configured) without spending an attempt; it cannot touch a claimed row');

  // Account erasure (red before the erasure patch, green after): rows go with the account.
  const closing = await profile('user', 'c@example.test');
  const open = (await enqueue(closing)).id;
  const inflight = (await enqueue(closing)).id;
  await claim(inflight);
  await c.query('RESET ROLE');
  await c.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1", [closing]);
  await c.query(`INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at)
    VALUES($1,$2,$3,clock_timestamp()-interval '1 minute')`, [closing, randomUUID(), randomUUID()]);
  await c.query('SET ROLE service_role');
  assert.deepEqual(await claim(open), { decision: 'skip' });
  assert.equal((await v('SELECT payment_notice_prepare($1) v', [inflight])).erasing, true);
  await c.query('RESET ROLE');
  assert.equal(await v("SELECT erasure_business_owner('payment_notices',$1) v", [JSON.stringify({ user_id: closing })]), closing);
  assert.equal(Number(await v('SELECT account_erasure_business_remaining($1) v', [closing])), 2);
  await c.query('SELECT account_erasure_prune_business($1)', [closing]);
  assert.equal(Number(await v('SELECT count(*) v FROM payment_notices WHERE user_id=$1', [closing])), 0);
  assert.equal(Number(await v('SELECT account_erasure_business_remaining($1) v', [closing])), 0);
  await c.query('SET ROLE service_role');
  assert.equal((await finish(inflight, 1, 'sent', 'msg_after')).state, 'gone');
  assert.equal(Number(await v('SELECT count(*) v FROM (SELECT 1 FROM payment_notices) x').catch(() => -1)), -1);
  report.checks.push('account erasure: new sends are skipped, the rows are pruned and counted, a late result is ignored');

  // ADMIN-SECRETS slot.
  await c.query('RESET ROLE');
  await c.query(read('packages/db/tests/platform-secrets/vault_stub.sql'));
  await c.query('SET ROLE service_role');
  const slots = (await v('SELECT platform_secret_status() v')).map(item => item.slot);
  assert.deepEqual(slots, ['openrouter', 'postforme', 'postforme_webhook', 'tikhub', 'parallel', 'firecrawl', 'resend']);
  await v("SELECT platform_secret_set('resend','re_fakefakefake_0000',0,$1) v", [admin]);
  assert.equal(await v("SELECT platform_secret_read('resend') v"), 're_fakefakefake_0000');
  await code(v("SELECT platform_secret_read('sendgrid') v"), '23514');
  await c.query('RESET ROLE');
  report.checks.push("the 'resend' slot is accepted by status, set and read; unknown slots stay refused");

  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
