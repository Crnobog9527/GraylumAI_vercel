/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BOT-GUARD part 3 (migration 0528, Owner 2026-11-13 "24 小时内最多送 5 个号吧"): up to signup_gift_ip_limit opening grants
// per IP in 24 hours (default 5), the setting's lenient read, the permanent refusal of the next one, one winner when two
// claims race for the IP's last place, and the "gift" count the claim now answers for the Owner's alert.
// Synthetic profiles, digests and documentation IPs only; no Auth, no network beyond the local container.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migration = readdirSync(new URL('../../migrations/', import.meta.url)).find(name => name.endsWith('_bot_guard_ip_limit.sql'));
assert.ok(migration, 'the BOT-GUARD ip-limit migration exists');
const db = await localDb(), c = db.client;
const report = { build: db.build, migration, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const setting = (key, value) => c.query(`INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)
  ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [key, JSON.stringify(value)]);
const profile = async () => { const id = randomUUID(); await c.query('INSERT INTO profiles(id) VALUES($1)', [id]); return id; };
const identity = () => JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: randomBytes(32).toString('hex') }]);
const claimRaw = async (id, ip, client = c) => {
  await client.query('BEGIN; SET LOCAL ROLE service_role');
  try {
    const sql = ip === undefined ? 'SELECT opening_grant_claim($1,$2) AS r' : 'SELECT opening_grant_claim($1,$2,$3::inet) AS r';
    const r = (await client.query(sql, ip === undefined ? [id, identity()] : [id, identity(), ip])).rows[0].r;
    await client.query('COMMIT');
    return r;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
};
const claim = async (id, ip, client) => (await claimRaw(id, ip, client)).granted;
const refusal = id => v("SELECT metadata->>'refusal' v FROM credit_transactions WHERE user_id=$1 AND idempotency_key='opening_grant:'||$1::text", [id]);
const balance = id => v('SELECT credits v FROM profiles WHERE id=$1', [id]);
const ipLimit = async () => (await v('SELECT signup_gift_today() v')).ip_limit;

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const applied = await v(catalogSql);
  await c.query(read(`packages/db/migrations/${migration}`));
  await c.query(read(`packages/db/migrations/${migration}`));
  assert.deepEqual(await v(catalogSql), applied);
  report.checks.push('applying the migration again (twice) leaves the catalog unchanged');
  await setting('signup_gift_daily_cap', 1000);

  // Default 5 per IP in 24 hours: five accounts from one network are granted, the sixth is refused for good.
  assert.equal(await ipLimit(), 5);
  const ip = '203.0.113.50';
  for (let i = 0; i < 5; i++) {
    const id = await profile();
    assert.equal(await claim(id, ip), true, `account ${i + 1}`);
    assert.equal(await balance(id), 500);
  }
  const sixth = await profile();
  assert.equal(await claim(sixth, ip), false);
  assert.equal(await refusal(sixth), 'same_ip');
  assert.equal(await v("SELECT description v FROM credit_transactions WHERE user_id=$1", [sixth]), 'Opening grant refused: same IP');
  assert.equal(await claim(await profile(), '203.0.113.51'), true, 'another network is unaffected');
  assert.equal(await claim(await profile()), true, 'no IP (old two-argument call): no IP rule');
  // After 24 hours the network may receive grants again; the refused account stays refused.
  await c.query("UPDATE signup_gift_ips SET granted_at=granted_at-interval '25 hours' WHERE ip=$1", [ip]);
  assert.equal(await claim(sixth, ip), false);
  assert.equal(await balance(sixth), 0);
  assert.equal(await claim(await profile(), ip), true);
  report.checks.push('default: 5 grants per IP in 24 hours, the 6th is refused (same_ip) and never topped up; other IPs, no IP and the IP after 24 hours are granted');

  // The setting: whole numbers 1-1000; anything else falls back to 5, above 1000 is clamped.
  await setting('signup_gift_ip_limit', '2');
  const ip2 = '198.51.100.70';
  assert.equal(await claim(await profile(), ip2), true);
  assert.equal(await claim(await profile(), ip2), true);
  const third = await profile();
  assert.equal(await claim(third, ip2), false);
  assert.equal(await refusal(third), 'same_ip');
  await setting('signup_gift_ip_limit', 3);
  assert.equal(await claim(await profile(), ip2), true, 'raising the limit lets the network get one more');
  assert.equal(await claim(third, ip2), false, 'but not the account refused before');
  for (const [value, expected] of [['abc', 5], [0, 5], ['', 5], [-1, 5], [1.5, 5], [5000, 50], [51, 50], ['1', 1], [50, 50]]) {
    await setting('signup_gift_ip_limit', value);
    assert.equal(await ipLimit(), expected, `ip limit ${JSON.stringify(value)}`);
  }
  report.checks.push('signup_gift_ip_limit: a lower limit refuses, a raised one admits new accounts only; bad values fall back to 5, above 50 -> 50');

  // The claim's answer: today's count and cap after a grant, nothing more on a refusal.
  await setting('signup_gift_ip_limit', 5);
  const answer = await claimRaw(await profile(), '192.0.2.80');
  const today = await v('SELECT signup_gift_today() v');
  assert.deepEqual(answer, { granted: true, gift: { day: today.day, granted: today.granted, cap: 1000 } });
  await setting('signup_gift_paused', true);
  assert.deepEqual(await claimRaw(await profile(), '192.0.2.81'), { granted: false });
  await setting('signup_gift_paused', false);
  report.checks.push('a grant answers {granted, gift: {day, granted, cap}}; a refusal answers {granted: false} only');

  // Who may read the admin card's history: service_role only; refusals are counted per reason on today's row.
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await v("SELECT has_function_privilege($1,'signup_gift_recent(integer)','execute') v", [role]), false, role);
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','signup_gift_recent(integer)','execute') v"), true);
  const recent = await v('SELECT signup_gift_recent(3) v');
  assert.equal(recent.length, 3);
  assert.equal(recent[0].day, today.day, 'newest first, today on top');
  assert.equal(recent[0].granted, today.granted);
  // So far today: one paused refusal; same_ip ones: the 6th account on ip, `third` on ip2 (twice tried, counted once).
  assert.deepEqual([recent[0].refused_paused, recent[0].refused_same_ip, recent[0].refused_daily_cap], [1, 2, 0]);
  assert.deepEqual(recent[1], { day: recent[1].day, granted: 0, refused_paused: 0, refused_same_ip: 0, refused_daily_cap: 0 });
  assert.equal((await v('SELECT signup_gift_recent(999) v')).length, 31, 'at most 31 days');
  assert.equal((await v('SELECT signup_gift_recent(0) v')).length, 1, 'at least today');
  report.checks.push('signup_gift_recent: service_role only, newest day first with grants and refusals per reason (a refused account counts once), 1-31 days');

  // The daily cap still applies on top of the per-IP limit.
  await setting('signup_gift_daily_cap', (await v('SELECT signup_gift_today() v')).granted);
  const capped = await profile();
  assert.equal(await claim(capped, '192.0.2.90'), false);
  assert.equal(await refusal(capped), 'daily_cap');
  assert.equal((await v('SELECT signup_gift_recent(1) v'))[0].refused_daily_cap, 1);
  await setting('signup_gift_daily_cap', 1000);
  report.checks.push('the daily cap still refuses (daily_cap) whatever the IP');

  // Concurrency: one place left for an IP, two claims from it at once: exactly one wins.
  const ip3 = '192.0.2.100';
  for (let i = 0; i < 4; i++) assert.equal(await claim(await profile(), ip3), true);
  const sessions = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
  await Promise.all(sessions.map(s => s.connect()));
  try {
    const racers = [await profile(), await profile()];
    const results = await Promise.all(racers.map((id, i) => claim(id, ip3, sessions[i])));
    assert.deepEqual([...results].sort(), [false, true]);
    assert.deepEqual((await Promise.all(racers.map(refusal))).sort(), ['same_ip', null].sort());
    assert.equal(await v('SELECT count(*)::int v FROM signup_gift_ips WHERE ip=$1', [ip3]), 5);
  } finally {
    await Promise.all(sessions.map(s => s.end()));
  }
  report.checks.push('two concurrent claims for an IP\'s last place: exactly one grant, the other refused same_ip');
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await db.close();
}
