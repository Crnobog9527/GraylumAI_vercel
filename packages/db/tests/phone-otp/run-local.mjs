/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PHONE-OTP verification of the sms_sends migration: who may call it, the per-number and per-IP limits of
// both steps (send route, Send SMS hook), giving a request back, profiles.phone (shape, client denial, erasure scrub),
// the in-app reminder read, and that applying the migration again changes nothing.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migration = readdirSync(new URL('../../migrations/', import.meta.url)).find(name => name.endsWith('_phone_otp_sms_sends.sql'));
assert.ok(migration, 'the PHONE-OTP migration exists');
const migrationPath = `packages/db/migrations/${migration}`;
const db = await localDb(), c = db.client;
const report = { build: db.build, migration, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const failure = promise => promise.then(() => null, e => e.message);
const key = n => n.toString(16).padStart(64, '0');
const request = (k, ip = '203.0.113.7') => v('SELECT sms_request_send($1,$2::inet) v', [k, ip]);
const authorize = k => v('SELECT sms_authorize_send($1) v', [k]);
// Moves this number's rows back in time, standing in for waiting.
const age = (k, seconds) => c.query(`UPDATE sms_sends SET requested_at=requested_at-make_interval(secs=>$2),
  sent_at=sent_at-make_interval(secs=>$2) WHERE phone_key=$1`, [k, seconds]);
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const applied = await v(catalogSql);
  await c.query(read(migrationPath));
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), applied);
  report.checks.push('applying the migration again (twice) leaves the catalog unchanged');

  const fns = ['sms_request_send(text,inet)', 'sms_authorize_send(text)', 'sms_release_send(text)', 'payment_notice_inbox(uuid)'];
  for (const role of ['anon', 'authenticated']) {
    for (const f of fns) assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
  }
  for (const f of fns) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await v("SELECT has_table_privilege($1,'public.sms_sends','select,insert,update,delete') v", [role]), false, role);
    assert.equal(await v("SELECT has_column_privilege($1,'public.profiles','phone','update') v", [role]), role === 'service_role');
  }
  report.checks.push('clients call nothing and touch neither sms_sends nor profiles.phone; service_role only through the functions');

  assert.equal(await failure(request('not-a-hash')), 'SMS_PHONE_KEY_INVALID');
  assert.equal(await failure(authorize(null)), 'SMS_PHONE_KEY_INVALID');
  const a = key(1);
  assert.equal(await authorize(a), 'no_request');
  assert.equal(await request(a), 'ok');
  assert.equal(await request(a), 'phone_cooldown');
  assert.equal(await authorize(a), 'ok');
  assert.equal(await authorize(a), 'no_request');
  assert.equal(await v('SELECT count(*)::int v FROM sms_sends WHERE phone_key=$1 AND sent_at IS NOT NULL', [a]), 1);
  report.checks.push('a code needs a fresh request first; one request sends one code; 60 seconds between requests');

  // A second request right after the first was sent: the hook still enforces 60 s between sent codes.
  await age(a, 61);
  assert.equal(await request(a), 'ok');
  await c.query("UPDATE sms_sends SET sent_at=now()-interval '10 seconds' WHERE phone_key=$1 AND sent_at IS NOT NULL", [a]);
  assert.equal(await authorize(a), 'phone_cooldown');
  await age(a, 61);
  // Five a day per number, counted on requests and again on sent codes.
  const b = key(2);
  for (let i = 0; i < 5; i++) {
    assert.equal(await request(b, `198.51.100.${i + 1}`), 'ok', `request ${i}`);
    assert.equal(await authorize(b), 'ok', `send ${i}`);
    await age(b, 61);
  }
  assert.equal(await request(b, '198.51.100.99'), 'phone_daily');
  await age(b, 24 * 3600);
  assert.equal(await request(b, '198.51.100.99'), 'ok');
  report.checks.push('5 codes per number per 24 hours; the window rolls');

  // Twenty a day per IP, whichever numbers.
  for (let i = 0; i < 20; i++) assert.equal(await request(key(100 + i), '192.0.2.1'), 'ok', `ip request ${i}`);
  assert.equal(await request(key(200), '192.0.2.1'), 'ip_daily');
  assert.equal(await request(key(200), '192.0.2.2'), 'ok');
  report.checks.push('20 requests per IP per 24 hours; another IP is unaffected');

  // Giving back a request Supabase refused before the hook: it no longer counts, a sent one is never given back.
  const r = key(3);
  assert.equal(await request(r), 'ok');
  await v('SELECT sms_release_send($1) v', [r]);
  assert.equal(await v('SELECT count(*)::int v FROM sms_sends WHERE phone_key=$1', [r]), 0);
  assert.equal(await request(r), 'ok');
  assert.equal(await authorize(r), 'ok');
  await v('SELECT sms_release_send($1) v', [r]);
  assert.equal(await v('SELECT count(*)::int v FROM sms_sends WHERE phone_key=$1', [r]), 1);
  // A stale request (over 2 minutes) cannot authorize a send.
  const s = key(4);
  assert.equal(await request(s), 'ok');
  await age(s, 121);
  assert.equal(await authorize(s), 'no_request');
  report.checks.push('release drops only the newest unsent request; a request older than 2 minutes sends nothing');

  // Old rows are swept by later requests.
  await c.query("INSERT INTO sms_sends(phone_key,requested_at) VALUES($1,now()-interval '3 days')", [key(5)]);
  assert.equal(await request(key(6)), 'ok');
  assert.equal(await v('SELECT count(*)::int v FROM sms_sends WHERE phone_key=$1', [key(5)]), 0);
  report.checks.push('rows older than two days are deleted by the next request');

  // profiles.phone: shape, erasure scrub.
  await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
  const user = await v('SELECT ws_test.actor() v');
  assert.match(await failure(c.query("UPDATE profiles SET phone='13800005678' WHERE id=$1", [user])), /profiles_phone_mainland/);
  await c.query('UPDATE profiles SET email=NULL,nickname=NULL,avatar_url=NULL,last_ip=NULL,last_login_at=NULL,phone=NULL WHERE id=$1', [user]);
  const before = Number(await v('SELECT account_erasure_local_remaining($1) v', [user]));
  await c.query("UPDATE profiles SET phone='8613800005678' WHERE id=$1", [user]);
  assert.equal(Number(await v('SELECT account_erasure_local_remaining($1) v', [user])), before + 1);
  const cleanup = await v("SELECT pg_get_functiondef('account_erasure_local_cleanup(uuid,boolean)'::regprocedure) v");
  assert.match(cleanup, /UPDATE profiles SET email=NULL,nickname=NULL[^;]*,phone=NULL/);
  report.checks.push('profiles.phone takes 86 + 11 digits only; erasure counts it as remaining and clears it with the other fields');

  // In-app reminders: own skipped no-recipient rows of the last 14 days, newest first.
  const other = await v('SELECT ws_test.actor() v');
  const notice = (who, kind, ref, state, code, days) => c.query(`INSERT INTO payment_notices(user_id,kind,source_ref,due_key,template_params,
    state,last_error_code,created_at) VALUES($1,$2,$3,'d',$4,$5,$6,now()-make_interval(days=>$7))`,
  [who, kind, ref, JSON.stringify({ endDate: '2026-11-15T00:00:00Z' }), state, code, days]);
  await notice(user, 'restore_pro_expiry', 'r1', 'skipped', 'PAYMENT_NOTICE_NO_RECIPIENT', 1);
  await notice(user, 'founder_ended', 'r2', 'skipped', 'PAYMENT_NOTICE_NO_RECIPIENT', 0);
  await notice(user, 'founder_ended', 'r3', 'skipped', 'PAYMENT_NOTICE_NO_RECIPIENT', 20);
  await notice(user, 'founder_ended', 'r4', 'skipped', 'PAYMENT_NOTICE_ACCOUNT_ERASURE', 0);
  await notice(other, 'founder_ended', 'r6', 'skipped', 'PAYMENT_NOTICE_NO_RECIPIENT', 0);
  const inbox = await v('SELECT payment_notice_inbox($1) v', [user]);
  assert.deepEqual(inbox.map(row => row.kind), ['founder_ended', 'restore_pro_expiry']);
  assert.deepEqual(Object.keys(inbox[0]).sort(), ['createdAt', 'id', 'kind', 'params']);
  report.checks.push('the reminder read returns only the account’s own unmailed reminders of the last 14 days');
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await db.close();
}
