/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BOT-GUARD verification of the sign-up guard migration on the full file-built database: who may call what, the
// registration limits, the Before User Created hook (email needs our registration, phone and Google pass), and the opening
// grant gate (pause, same IP, Beijing-day cap, permanent refusal, one winner under concurrency, the Waffo path untouched).
// Synthetic profiles, digests and documentation IPs only; no Auth, no network beyond the local container.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migration = readdirSync(new URL('../../migrations/', import.meta.url)).find(name => name.endsWith('_bot_guard_signup.sql'));
assert.ok(migration, 'the BOT-GUARD migration exists');
const migrationPath = `packages/db/migrations/${migration}`;
const db = await localDb(), c = db.client;
const report = { build: db.build, migration, checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const failure = promise => promise.then(() => null, e => e.message);
const emailKey = email => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const request = (key, ip = '203.0.113.7') => v('SELECT signup_request($1,$2::inet) v', [key, ip]);
const hook = user => v('SELECT hook_before_user_created($1::jsonb) v', [JSON.stringify({ metadata: { name: 'before-user-created' }, user })]);
const refused = { error: { http_code: 403, message: 'Please sign up on the website.' } };
const setting = (key, value) => c.query(`INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)
  ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [key, JSON.stringify(value)]);
const profile = async () => { const id = randomUUID(); await c.query('INSERT INTO profiles(id) VALUES($1)', [id]); return id; };
const identity = () => JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: randomBytes(32).toString('hex') }]);
const claim = async (id, ip, client = c, digests = identity()) => {
  await client.query('BEGIN; SET LOCAL ROLE service_role');
  try {
    const args = ip === undefined ? [id, digests] : [id, digests, ip];
    const sql = ip === undefined ? 'SELECT opening_grant_claim($1,$2) AS r' : 'SELECT opening_grant_claim($1,$2,$3::inet) AS r';
    const granted = (await client.query(sql, args)).rows[0].r.granted;
    await client.query('COMMIT');
    return granted;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
};
const balance = id => v('SELECT credits v FROM profiles WHERE id=$1', [id]);
const refusal = id => v("SELECT metadata->>'refusal' v FROM credit_transactions WHERE user_id=$1 AND idempotency_key='opening_grant:'||$1::text", [id]);
const today = () => v('SELECT signup_gift_today() v');

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const applied = await v(catalogSql);
  await c.query(read(migrationPath));
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), applied);
  report.checks.push('applying the migration again (twice) leaves the catalog unchanged');

  // Old signatures are gone (one function each, trailing p_ip defaulted), so two-argument calls still resolve.
  assert.equal(await v("SELECT to_regprocedure('public.opening_grant_claim(uuid,jsonb)') v"), null);
  assert.equal(await v("SELECT to_regprocedure('public.opening_grant_remember(uuid,jsonb,boolean)') v"), null);
  const fns = { 'signup_request(text,inet)': 'service_role', 'signup_gift_today()': 'service_role',
    'opening_grant_claim(uuid,jsonb,inet)': 'service_role', 'opening_grant_remember(uuid,jsonb,boolean,inet)': null,
    'signup_gift_settings()': null, 'signup_gift_day()': null, 'hook_before_user_created(jsonb)': 'supabase_auth_admin' };
  for (const [fn, allowed] of Object.entries(fns)) {
    for (const role of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, fn]), role === allowed, `${role} ${fn}`);
    }
  }
  for (const table of ['signup_requests', 'signup_gift_days', 'signup_gift_ips']) {
    assert.equal(await v("SELECT relrowsecurity v FROM pg_class WHERE oid=$1::regclass", [`public.${table}`]), true, table);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await v("SELECT has_table_privilege($1,$2,'select,insert,update,delete') v", [role, `public.${table}`]), false, `${role} ${table}`);
    }
  }
  report.checks.push('clients call nothing; service_role only the registration, today read and claim; the hook only supabase_auth_admin; tables RLS, no grants');

  // Registration: 5 per IP per hour, 20 per IP per day, other IPs unaffected, old rows swept.
  assert.equal(await failure(request('not-a-hash')), 'SIGNUP_EMAIL_KEY_INVALID');
  for (let i = 0; i < 5; i++) assert.equal(await request(emailKey(`h${i}@example.com`), '192.0.2.10'), 'ok', `hour ${i}`);
  assert.equal(await request(emailKey('h5@example.com'), '192.0.2.10'), 'ip_hourly');
  assert.equal(await request(emailKey('h5@example.com'), '192.0.2.11'), 'ok');
  await c.query("UPDATE signup_requests SET requested_at=requested_at-interval '61 minutes' WHERE ip='192.0.2.10'");
  for (let i = 0; i < 5; i++) assert.equal(await request(emailKey(`d${i}@example.com`), '192.0.2.10'), 'ok', `second hour ${i}`);
  for (let round = 0; round < 2; round++) {
    await c.query("UPDATE signup_requests SET requested_at=requested_at-interval '61 minutes' WHERE ip='192.0.2.10'");
    for (let i = 0; i < 5; i++) assert.equal(await request(emailKey(`r${round}${i}@example.com`), '192.0.2.10'), 'ok');
  }
  await c.query("UPDATE signup_requests SET requested_at=requested_at-interval '61 minutes' WHERE ip='192.0.2.10'");
  assert.equal(await request(emailKey('over@example.com'), '192.0.2.10'), 'ip_daily');
  await c.query("INSERT INTO signup_requests(email_key,requested_at) VALUES($1,now()-interval '3 days')", [emailKey('old@example.com')]);
  assert.equal(await request(emailKey('sweep@example.com'), '192.0.2.12'), 'ok');
  assert.equal(await v('SELECT count(*)::int v FROM signup_requests WHERE email_key=$1', [emailKey('old@example.com')]), 0);
  report.checks.push('registration: 5 per IP per hour and 20 per 24 hours, another IP unaffected, rows older than two days swept');

  // The hook: an email sign-up needs our registration from the last 10 minutes (normalised address); phone and Google pass.
  assert.deepEqual(await hook({ email: 'direct@example.com', app_metadata: { provider: 'email' } }), refused);
  assert.deepEqual(await hook({ email: 'direct@example.com', phone: '' }), refused, 'provider-less email sign-up');
  assert.equal(await request(emailKey('site@example.com'), '198.51.100.5'), 'ok');
  assert.deepEqual(await hook({ email: '  Site@Example.com ', app_metadata: { provider: 'email' } }), {});
  await c.query("UPDATE signup_requests SET requested_at=now()-interval '11 minutes' WHERE email_key=$1", [emailKey('site@example.com')]);
  assert.deepEqual(await hook({ email: 'site@example.com', app_metadata: { provider: 'email' } }), refused, 'registration too old');
  assert.deepEqual(await hook({ email: '', app_metadata: { provider: 'email' } }), refused, 'email provider without an address');
  assert.deepEqual(await hook({ phone: '8613800005678', app_metadata: { provider: 'phone' } }), {});
  assert.deepEqual(await hook({ email: 'g@example.com', app_metadata: { provider: 'google', providers: ['google'] } }), {});
  assert.deepEqual(await v('SELECT hook_before_user_created($1::jsonb) v', ['{}']), {}, 'an event without a user is not an email sign-up');
  report.checks.push('hook refuses email sign-ups without a fresh registration (403), accepts with one; phone and Google pass');

  // Grant gate. A fresh database: nothing granted today, default cap 30, not paused.
  assert.deepEqual(await today(), { cap: 30, paused: false, granted: 0, day: await v("SELECT to_char(signup_gift_day(),'YYYY-MM-DD') v") });
  const first = await profile();
  assert.equal(await claim(first, '203.0.113.20'), true);
  assert.equal(await balance(first), 500);
  assert.equal((await today()).granted, 1);
  assert.equal(await claim(first, '203.0.113.20'), false, 'replay of a granted account');
  assert.equal(await balance(first), 500);
  assert.equal((await today()).granted, 1, 'a replay is not counted');
  report.checks.push('an eligible claim grants 500 once and counts one; a replay changes nothing');

  // Same IP within 24 hours: refused, permanently; another IP or no IP (old two-argument call) is granted.
  const sameIp = await profile();
  assert.equal(await claim(sameIp, '203.0.113.20'), false);
  assert.equal(await refusal(sameIp), 'same_ip');
  assert.equal(await balance(sameIp), 0);
  assert.equal(await claim(await profile(), '203.0.113.21'), true);
  assert.equal(await claim(await profile()), true, 'two-argument call: no IP rule');
  await c.query("UPDATE signup_gift_ips SET granted_at=granted_at-interval '25 hours' WHERE ip='203.0.113.20'");
  assert.equal(await claim(sameIp, '203.0.113.99'), false, 'a refused account stays refused');
  assert.equal(await balance(sameIp), 0);
  assert.equal(await claim(await profile(), '203.0.113.20'), true, 'the IP is eligible again after 24 hours');
  report.checks.push('same IP within 24 hours is refused (same_ip) and stays refused; other IPs, no IP and the IP after 24 hours are granted');

  // Daily cap: reached -> refused (daily_cap); raising it later does not top the refused account up.
  const granted = (await today()).granted;
  await setting('signup_gift_daily_cap', granted);
  const capped = await profile();
  assert.equal(await claim(capped, '203.0.113.30'), false);
  assert.equal(await refusal(capped), 'daily_cap');
  await setting('signup_gift_daily_cap', '0');
  const zero = await profile();
  assert.equal(await claim(zero, '203.0.113.31'), false);
  assert.equal(await refusal(zero), 'daily_cap');
  await setting('signup_gift_daily_cap', 'not a number');
  assert.equal((await today()).cap, 30, 'an unreadable cap falls back to 30');
  await setting('signup_gift_daily_cap', 999999999);
  assert.equal((await today()).cap, 100000, 'the cap is clamped to 100000');
  assert.equal(await claim(capped, '203.0.113.30'), false);
  assert.equal(await claim(zero, '203.0.113.31'), false);
  assert.deepEqual([await balance(capped), await balance(zero)], [0, 0]);
  // The count is per Beijing day: yesterday's grants do not count today.
  await setting('signup_gift_daily_cap', granted);
  await c.query('UPDATE signup_gift_days SET day=day-1');
  assert.equal(await claim(await profile(), '203.0.113.32'), true, 'a new Beijing day starts at zero');
  assert.equal((await today()).granted, 1);
  report.checks.push('the Beijing-day cap refuses (daily_cap), 0 refuses all, bad values fall back to 30, raising it never tops up a refused account');

  // Pause: refused (paused) whatever the cap; unpausing does not top the account up.
  await setting('signup_gift_daily_cap', 30);
  await setting('signup_gift_paused', true);
  const paused = await profile();
  assert.equal(await claim(paused, '203.0.113.40'), false);
  assert.equal(await refusal(paused), 'paused');
  await setting('signup_gift_paused', 'false');
  assert.equal(await claim(paused, '203.0.113.40'), false);
  assert.equal(await balance(paused), 0);
  assert.equal(await claim(await profile(), '203.0.113.41'), true);
  report.checks.push('pause refuses (paused) and stays refused after unpausing; new accounts are granted again');

  // Exactly one decision row per refused account, with the existing reason code and no balance change.
  const rows = (await c.query(`SELECT amount::int amount,ledger_type,reason_code,balance_before::int balance_before,balance_after::int balance_after FROM credit_transactions
    WHERE user_id=ANY($1::uuid[]) AND idempotency_key='opening_grant:'||user_id::text`, [[sameIp, capped, zero, paused]])).rows;
  assert.equal(rows.length, 4);
  for (const row of rows) assert.deepEqual(row, { amount: 0, ledger_type: 'adjustment', reason_code: 'opening_grant_ineligible', balance_before: 0, balance_after: 0 });
  report.checks.push('each refusal is one zero-value opening_grant_ineligible decision row');

  // The Waffo path (p_allow_grant false) never reaches the gate: no lock, no count, no row.
  const waffo = await profile(), before = (await today()).granted;
  assert.equal(await v('SELECT opening_grant_remember($1,$2,false) v', [waffo, identity()]), false);
  assert.equal((await today()).granted, before);
  assert.equal(await v("SELECT count(*)::int v FROM credit_transactions WHERE user_id=$1", [waffo]), 0);
  report.checks.push('the three-argument Waffo call (no grant) still resolves and writes nothing');

  // Concurrency: one place left under the cap, two different-IP claims at once: exactly one wins.
  await setting('signup_gift_daily_cap', (await today()).granted + 1);
  const sessions = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
  await Promise.all(sessions.map(s => s.connect()));
  try {
    const racers = [await profile(), await profile()];
    const results = await Promise.all(racers.map((id, i) => claim(id, `198.51.100.${60 + i}`, sessions[i])));
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await today()).granted, (await today()).cap);
    assert.deepEqual((await Promise.all(racers.map(refusal))).sort(), ['daily_cap', null].sort());
  } finally {
    await Promise.all(sessions.map(s => s.end()));
  }
  report.checks.push('two concurrent claims for the last place: exactly one grant, the other refused daily_cap');

  // Old gift-IP rows are swept by later grants.
  await setting('signup_gift_daily_cap', 1000);
  await c.query("INSERT INTO signup_gift_ips(ip,granted_at) VALUES('192.0.2.200',now()-interval '3 days')");
  assert.equal(await claim(await profile(), '192.0.2.201'), true);
  assert.equal(await v("SELECT count(*)::int v FROM signup_gift_ips WHERE ip='192.0.2.200'"), 0);
  report.checks.push('gift-IP rows older than two days are swept by the next grant');
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await db.close();
}
