/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PAY-FOUNDER PR-F1 verification: founder status, wall consent and review, community list,
// livestream records, grants and account-erasure cleanup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { founderErasureCases } from './erasure.mjs';
import { orderFixtures } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0269_pay_founder_foundation.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0269', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const ok = (name) => report.checks.push(name);
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  ok('reapplication after the full chain preserves the complete catalog');

  const granted = ['pay_founder_status(uuid)', 'founder_member_state(uuid)', 'founder_wall_submit(uuid,jsonb,text)',
    'founder_wall_withdraw(uuid)', 'founder_wall_public()', 'founder_wall_review(uuid,uuid,text,timestamp with time zone)',
    'founder_admin_overview(uuid)', 'founder_community_mark(uuid,uuid,text)', 'founder_community_entry_set(uuid,text,text)',
    'founder_livestream_list(uuid)', 'founder_livestream_record(uuid,uuid,date,text,text)'];
  const internal = ['pay_founder_order_frozen(uuid)', 'founder_account_open(uuid)', 'founder_wall_consented(uuid)',
    'founder_wall_listed(uuid)', 'founder_admin_check(uuid)', 'founder_wall_valid_url(text)'];
  for (const role of ['anon', 'authenticated']) {
    for (const f of [...granted, ...internal]) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
  }
  for (const f of granted) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
  for (const f of internal) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), false, f);
  for (const t of ['founder_wall_entries', 'founder_community_status']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(await v('SELECT has_table_privilege($1,$2,$3) v', [role, t, p]), false, `${role} ${t} ${p}`);
      }
    }
    assert.equal(await v('SELECT relrowsecurity v FROM pg_class WHERE oid=$1::regclass', [t]), true);
  }
  // Clients cannot call the status function directly (acceptance: anonymous and ordinary users refused).
  for (const role of ['anon', 'authenticated']) {
    await c.query(`SET ROLE ${role}`);
    try { await code(c.query('SELECT pay_founder_status($1)', [randomUUID()]), '42501'); }
    finally { await c.query('RESET ROLE'); }
  }
  ok('clients have no table or function access; service_role only via the listed RPCs; RLS on');

  const fx = await orderFixtures(c);
  const status = a => v('SELECT pay_founder_status($1) v', [a]);
  const state = async a => (await status(a)).state;
  const day = 86400000, now = Date.now();

  const none = await fx.profile();
  assert.deepEqual(await status(none), { state: 'none', orderId: null, foundedAt: null, periodEnd: null, deadline: null,
    endedAt: null, endedReason: null });
  const standard = await fx.profile();
  await fx.order(standard, { offer: 'standard', start: now - 10 * day, end: now + 300 * day });
  assert.equal(await state(standard), 'none', 'a standard Gold order is not a founder');
  const reserved = await fx.profile();
  await fx.order(reserved, { qualification: 'reserved', start: now - 10 * day, end: now + 300 * day });
  assert.equal(await state(reserved), 'none', 'an unsold reservation is not a founder');
  ok('none: no sold founder order, standard orders and reservations do not count');

  const wallet = await fx.profile();
  const walletOrder = await fx.order(wallet, { method: 'alipay', start: now - 10 * day, end: now + 355 * day });
  const active = await status(wallet);
  assert.equal(active.state, 'active'); assert.equal(active.orderId, walletOrder);
  const walletGrace = await fx.profile();
  await fx.order(walletGrace, { method: 'wechat_pay', start: now - 367 * day, end: now - 2 * day });
  const grace = await status(walletGrace);
  assert.equal(grace.state, 'grace'); assert.ok(new Date(grace.deadline) > new Date());
  const walletEnded = await fx.profile();
  await fx.order(walletEnded, { method: 'alipay', start: now - 373 * day, end: now - 8 * day });
  assert.deepEqual([(await status(walletEnded)).state, (await status(walletEnded)).endedReason], ['ended', 'expired']);
  const renewed = await fx.profile();
  await fx.order(renewed, { method: 'alipay', start: now - 370 * day, end: now - 5 * day });
  await fx.order(renewed, { method: 'alipay', offer: 'founder_renewal', start: now - 5 * day, end: now + 360 * day,
    paid: now - 2 * day });
  assert.equal(await state(renewed), 'active', 'a wallet renewal inside the window keeps the identity');
  ok('wallet: active in term, grace for 7 days after the end, ended after; in-window renewal stays active');

  const cardAwait = await fx.profile();
  await fx.order(cardAwait, { method: 'card_cn', start: now - 366 * day, end: now - 3600000 });
  assert.equal(await state(cardAwait), 'grace', 'renewal outcome not yet known keeps the 7-day window');
  const cardFailed = await fx.profile();
  await fx.order(cardFailed, { method: 'card', start: now - 375 * day, end: now - 10 * day, failedAt: now - 9 * day });
  assert.equal(await state(cardFailed), 'ended');
  const cardFailing = await fx.profile();
  await fx.order(cardFailing, { method: 'card', start: now - 368 * day, end: now - 3 * day, failedAt: now - 3 * day });
  assert.equal(await state(cardFailing), 'grace');
  const cardOptOut = await fx.profile();
  await fx.order(cardOptOut, { method: 'card_cn', start: now - 366 * day, end: now - 3600000, cancelRequested: true });
  assert.equal(await state(cardOptOut), 'ended', 'a renewal the buyer turned off has no founder window');
  const lapsed = await fx.profile();
  await fx.order(lapsed, { method: 'card_cn', start: now - 380 * day, end: now - 15 * day });
  await fx.order(lapsed, { method: 'card_cn', offer: 'founder_renewal', start: now - 15 * day, end: now + 350 * day,
    paid: now - 4 * day });
  assert.deepEqual([(await status(lapsed)).state, (await status(lapsed)).endedReason], ['ended', 'lapsed']);
  ok('card: grace while renewal pending or failed under 7 days; ended after; late renewal or opt-out never restores');

  const refunded = await fx.profile();
  const refundedOrder = await fx.order(refunded, { method: 'alipay', start: now - 3 * day, end: now + 362 * day,
    refund: 'refunded' });
  assert.deepEqual([(await status(refunded)).state, (await status(refunded)).endedReason], ['ended', 'refunded']);
  const partial = await fx.profile();
  await fx.order(partial, { method: 'card', start: now - 100 * day, end: now + 265 * day, refund: 'partially_refunded' });
  assert.equal(await state(partial), 'ended', 'a remaining-time refund also ends the identity');
  assert.ok(refundedOrder);
  ok('refund (full or remaining-time) ends the identity immediately');

  // Dispute freeze hook: PR-D1 replaces the body; frozen is temporary and separate from ended.
  const frozenUser = await fx.profile();
  const frozenOrder = await fx.order(frozenUser, { method: 'card', start: now - 10 * day, end: now + 355 * day });
  const setFrozen = ids => c.query(`CREATE OR REPLACE FUNCTION public.pay_founder_order_frozen(p_order uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT p_order = ANY('${`{${ids.join(',')}}`}'::uuid[]) $$`);
  await setFrozen([frozenOrder]);
  assert.equal(await state(frozenUser), 'frozen');
  assert.equal(await state(walletEnded), 'ended');
  await setFrozen([]);
  assert.equal(await state(frozenUser), 'active', 'unfreezing restores the identity automatically');
  ok('frozen: dispute hook takes the identity down temporarily; lifting it restores active');

  const ctx = { c, v, code, ok, fx, status, state, setFrozen, now, day, active: wallet, ended: walletEnded,
    frozenUser, frozenOrder, connect: async () => { const x = new pg.Client(c.connectionParameters); await x.connect(); return x; } };
  await wallCases(ctx);
  await communityCases(ctx);
  await founderErasureCases(ctx);
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  ok('account-open policy audit still returns zero rows');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}

async function wallCases({ c, v, code, ok, fx, now, day, setFrozen, frozenUser, frozenOrder, connect }) {
  const admin = await fx.profile('admin');
  const member = await fx.profile();
  await fx.order(member, { method: 'card', start: now - 10 * day, end: now + 355 * day });
  const entry = { displayName: '小灰', socialAccounts: [{ platform: 'xiaohongshu', handle: '小灰做账号',
    url: 'https://www.xiaohongshu.com/user/profile/abc' }], productName: 'Graylum 课', productUrl: 'https://example.com/course',
  intro: '帮新手做账号定位' };
  const submit = (a, e = entry, version = 'fw-v1', client = c) =>
    v('SELECT founder_wall_submit($1,$2,$3) v', [a, JSON.stringify(e), version], client);
  const pub = () => v('SELECT founder_wall_public() v');
  const team = a => v('SELECT data_use_consent_state($1) v', [a]);
  const consents = async a => (await c.query("SELECT purpose,version,revoke_reason FROM data_use_consents WHERE profile_id=$1"
    + ' ORDER BY granted_at,id', [a])).rows;
  const review = (a, decision, seen, actor = admin) =>
    v('SELECT founder_wall_review($1,$2,$3,$4) v', [actor, a, decision, seen]);
  const seen = async a => v('SELECT updated_at::text v FROM founder_wall_entries WHERE user_id=$1', [a]);

  const outsider = await fx.profile();
  await code(submit(outsider), '42501');
  const endedUser = await fx.profile();
  await fx.order(endedUser, { method: 'alipay', start: now - 373 * day, end: now - 8 * day });
  await code(submit(endedUser), '42501');
  await code(submit(member, entry, 'fw-v0'), 'PT409');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://a@evil.example/', 'https://a:b@evil.example/',
    'http://example.com/', 'https://exa mple.com/', 'https://example.com/\\x', 'https://example.com/\u0007']) {
    await code(submit(member, { ...entry, productUrl: bad }), '23514');
    await code(submit(member, { ...entry, socialAccounts: [{ ...entry.socialAccounts[0], url: bad }] }), '23514');
  }
  await code(submit(member, { ...entry, socialAccounts: Array(4).fill(entry.socialAccounts[0]) }), '23514');
  await code(submit(member, { ...entry, extra: 1 }), '23514');
  await code(submit(member, { ...entry, intro: 'x'.repeat(121) }), '23514');
  assert.equal(await v('SELECT count(*)::int v FROM founder_wall_entries WHERE user_id=$1', [member]), 0);
  assert.deepEqual(await consents(member), []);
  ok('refused: non-founder, ended founder, stale consent version, unsafe links, extra fields; nothing stored');

  const teamBefore = await team(member);
  const first = await submit(member);
  assert.equal(first.entry.reviewState, 'pending'); assert.equal(first.consent.granted, true); assert.equal(first.listed, false);
  assert.deepEqual(await pub(), []);
  assert.deepEqual(await team(member), teamBefore, 'founder_wall consent does not touch team_improvement');
  await v("SELECT data_use_consent_set($1,true,'d5-v1') v", [member]);
  await v("SELECT data_use_consent_set($1,false,'d5-v1') v", [member]);
  assert.equal((await v('SELECT founder_member_state($1) v', [member])).consent.granted, true, 'team revoke leaves founder_wall');
  ok('submit with consent goes to review; the two consents never affect each other');

  await code(review(member, 'approved', await seen(member), member), '42501');
  await code(review(member, 'approved', '2000-01-01T00:00:00Z'), 'PT409');
  const approved = await review(member, 'approved', await seen(member));
  assert.equal(approved.listed, true);
  assert.deepEqual((await pub()).map(x => x.displayName), ['小灰']);
  assert.equal(JSON.stringify(await pub()).includes(member), false, 'the public wall carries no account id');
  await submit(member);
  assert.equal((await v('SELECT founder_member_state($1) v', [member])).entry.reviewState, 'approved', 'identical resubmit');
  await submit(member, { ...entry, intro: '改过的介绍' });
  assert.equal((await v('SELECT founder_member_state($1) v', [member])).entry.reviewState, 'pending');
  assert.deepEqual(await pub(), [], 'an edited card leaves the wall until approved again');
  await review(member, 'approved', await seen(member));
  ok('admin-only review against the version seen; any edit returns the card to review');

  // Concurrent submits and withdrawals on two connections: one row, at most one active consent.
  const [one, two] = [await connect(), await connect()];
  try {
    const results = await Promise.allSettled([submit(member, { ...entry, intro: 'A' }, 'fw-v1', one),
      submit(member, { ...entry, intro: 'B' }, 'fw-v1', two), v('SELECT founder_wall_withdraw($1) v', [member], one)]);
    assert.ok(results.every(r => r.status === 'fulfilled'), JSON.stringify(results));
  } finally { await one.end(); await two.end(); }
  assert.ok(await v('SELECT count(*)::int v FROM founder_wall_entries WHERE user_id=$1', [member]) <= 1);
  assert.ok(await v("SELECT count(*)::int v FROM data_use_consents WHERE profile_id=$1 AND purpose='founder_wall'"
    + ' AND revoked_at IS NULL', [member]) <= 1);
  ok('concurrent submit and withdraw serialize on the profile lock and stay at one row');

  await submit(member); await review(member, 'approved', await seen(member));
  await setFrozen([frozenOrder, ...(await c.query("SELECT array_agg(id) a FROM payment_orders WHERE user_id=$1", [member])).rows[0].a]);
  assert.deepEqual(await pub(), [], 'a frozen founder is taken down');
  await setFrozen([]);
  assert.equal((await pub()).length, 1, 'and restored when the freeze is lifted');
  assert.ok(frozenUser);
  const withdrawn = await v('SELECT founder_wall_withdraw($1) v', [member]);
  assert.equal(withdrawn.entry, null); assert.equal(withdrawn.consent.granted, false);
  await v('SELECT founder_wall_withdraw($1) v', [member]);
  assert.deepEqual(await pub(), []);
  assert.equal((await consents(member)).filter(r => r.purpose === 'founder_wall').at(-1).revoke_reason, 'user');
  ok('withdraw is immediate and idempotent; the consent audit row stays with reason user');

  // A founder whose identity ends keeps the row but leaves the wall.
  const leaving = await fx.profile();
  const order = await fx.order(leaving, { method: 'alipay', start: now - 30 * day, end: now + 335 * day });
  await submit(leaving); await review(leaving, 'approved', await seen(leaving));
  assert.equal((await pub()).length, 1);
  await fx.refund(order);
  assert.deepEqual(await pub(), []);
  assert.equal(await v('SELECT count(*)::int v FROM founder_wall_entries WHERE user_id=$1', [leaving]), 1);
  ok('ended identity: card hidden from the wall, row kept for the member to see');
}

async function communityCases({ v, code, ok, fx, now, day, setFrozen }) {
  const admin = await fx.profile('admin');
  const user = await fx.profile();
  const order = await fx.order(user, { method: 'alipay', start: now - 30 * day, end: now + 335 * day });
  const mark = (a, action, actor = admin) => v('SELECT founder_community_mark($1,$2,$3) v', [actor, a, action]);
  const overview = async () => v('SELECT founder_admin_overview($1) v', [admin]);
  const row = async a => (await overview()).find(r => r.userId === a);

  await code(mark(user, 'joined', user), '42501');
  await code(v('SELECT founder_admin_overview($1) v', [user]), '42501');
  await code(mark(await fx.profile(), 'joined'), 'P0002');
  await code(mark(user, 'removed'), '23514');
  const joined = await mark(user, 'joined');
  assert.deepEqual(await mark(user, 'joined'), joined, 'repeat join is unchanged');
  assert.equal((await row(user)).pendingRemoval, false);
  assert.ok((await row(user)).email !== undefined, 'admin overview includes the login email field');
  await setFrozen([order]);
  assert.equal((await row(user)).founder.state, 'frozen');
  assert.equal((await row(user)).pendingRemoval, false, 'frozen is not pending removal');
  await setFrozen([]);
  await fx.refund(order);
  assert.equal((await row(user)).pendingRemoval, true, 'ended + joined + not removed');
  const removed = await mark(user, 'removed');
  assert.deepEqual(await mark(user, 'removed'), removed, 'repeat removal is unchanged');
  assert.equal((await row(user)).pendingRemoval, false);
  ok('community: admin-only, idempotent join/remove; pending removal computed for ended, not frozen');

  const entry = await v('SELECT founder_community_entry_set($1,$2,$3) v', [admin, 'https://example.com/join', '扫码加微信群']);
  assert.equal(entry.url, 'https://example.com/join');
  await code(v('SELECT founder_community_entry_set($1,$2,$3) v', [admin, 'javascript:x', null]), '23514');
  await code(v('SELECT founder_community_entry_set($1,$2,$3) v', [user, null, null]), '42501');
  const activeUser = await fx.profile();
  await fx.order(activeUser, { method: 'alipay', start: now - 1 * day, end: now + 364 * day });
  assert.equal((await v('SELECT founder_member_state($1) v', [activeUser])).community.note, '扫码加微信群');
  assert.equal((await v('SELECT founder_member_state($1) v', [user])).community, null, 'ended members see no entry');
  ok('community entry: admin-set, shown only to active or grace founders');

  const request = randomUUID();
  const record = (actor, req, url = 'https://example.com/replay') =>
    v('SELECT founder_livestream_record($1,$2,$3,$4,$5) v', [actor, req, '2026-10-15', '案例拆解：小红书起号', url]);
  await code(record(user, request), '42501');
  await code(record(admin, request, 'javascript:x'), '23514');
  await record(admin, request); await record(admin, request);
  const list = await v('SELECT founder_livestream_list($1) v', [admin]);
  assert.equal(list.length, 1); assert.equal(list[0].topic, '案例拆解：小红书起号');
  assert.equal(await v("SELECT count(*)::int v FROM user_activity_logs WHERE action='founder_livestream' AND user_id IS NULL"), 1);
  ok('livestream records: admin-only, one row per request, no member linked');
}
