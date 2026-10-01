// Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
// Synthetic local PG17/Auth/PostgREST only: node packages/db/tests/run-invite-abuse.mjs --local-only.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient, type User } from '@supabase/supabase-js';
import { invitationRouter } from '../routers/invitation';
import { createRuntimeBudget } from '../trpc';
import { confirmAccountErasure } from './accountErasure/service';
import { openingGrantDigests } from './accountErasure/openingGrantIdentity';
vi.mock('./redisRateLimiter', () => ({ checkRateLimitOrThrow: vi.fn().mockResolvedValue({ success: true }) }));
const rest = process.env.ERASURE_E_LOCAL_REST!;
const auth = process.env.ERASURE_E_LOCAL_AUTH!;
const connectionString = process.env.ERASURE_E_LOCAL_DB!;
if (![rest, auth].every(url => /^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? ''))
  || !/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/erasure_e$/.test(connectionString ?? '')) throw new Error('Local runner required');
const db = new pg.Client({ connectionString });
const localFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== rest) throw new Error('Non-local request forbidden');
  return fetch(new URL(url.pathname.replace(/^\/(auth|rest)\/v1/, '') + url.search,
    url.pathname.startsWith('/auth/v1') ? auth : rest), init);
};
const client = (key: string) => createClient(rest, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});
const admin = client(process.env.ERASURE_E_SERVICE_JWT!);
const password = 'test-only-invite-abuse-password';
const claimSql = "SELECT * FROM public.atomic_claim_invitation_code($1,$2,'synthetic@example.test',"
  + "'server_decides','low',NULL,999999,999999,$3,NULL)";
const claim = async (code: string, id: string, ip: string | null = null, session = db) =>
  (await session.query(claimSql, [code, id, ip])).rows[0];
const balance = async (id: string) => (await db.query('SELECT credits FROM profiles WHERE id=$1', [id])).rows[0].credits;
const settings = async (values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) await db.query(
    'INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, JSON.stringify(value)]);
};
async function profile(opening: number | null = 100) {
  const id = randomUUID();
  await db.query("INSERT INTO profiles(id,email,credits,status,is_deleted) VALUES($1,$2,0,'active','false')", [id, `${id}@example.test`]);
  if (opening !== null) await db.query('INSERT INTO credit_transactions(user_id,amount,type,idempotency_key)'
    + " VALUES($1,$2,'addition','opening_grant:'||$1::uuid::text)", [id, opening]);
  return id;
}
async function code(inviter: string) {
  const value = randomUUID().replaceAll('-', '').slice(0, 10);
  await db.query("INSERT INTO invitations(code,created_by,status) VALUES($1,$2,'active')", [value, inviter]);
  return value;
}
beforeAll(async () => { await db.connect(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await db.query("DELETE FROM system_settings WHERE key LIKE 'invite_%'"); });

it('requires exact positive opening decision, ignores supplied awards, and preserves one account decision', async () => {
  const inviter = await profile(), invitee = await profile();
  const first = await code(inviter), second = await code(inviter);
  expect(await balance(invitee)).toBe(0); // Eligibility is a historical decision, never the current balance.
  expect(await claim(first, invitee)).toMatchObject({ status: 'rewarded', inviter_reward: 50, invitee_reward: 30 });
  expect(await claim(first, invitee)).toMatchObject({ is_idempotent: true, invitee_reward: 30 });
  expect(await claim(second, invitee)).toMatchObject({ status: 'rejected', block_reason: 'invitation_already_decided',
    inviter_reward: 0, invitee_reward: 0 });
  expect(await balance(invitee)).toBe(30);
  expect((await db.query('SELECT status FROM invitations WHERE code=$1', [second])).rows[0].status).toBe('active');
  expect(Number((await db.query('SELECT count(*) FROM invitation_records WHERE invitee_id=$1', [invitee])).rows[0].count)).toBe(1);
  for (const opening of [0, -1]) {
    const denied = await profile(opening), one = await code(inviter), two = await code(inviter);
    expect(await claim(one, denied)).toMatchObject({ status: 'rejected', block_reason: 'invitation_opening_ineligible',
      inviter_reward: 0, invitee_reward: 0 });
    expect(await claim(two, denied)).toMatchObject({ block_reason: 'invitation_already_decided' });
    expect(await balance(denied)).toBe(0);
  }
  const missing = await profile(null), missingCode = await code(inviter);
  await db.query("INSERT INTO credit_transactions(user_id,amount,type,idempotency_key) VALUES($1,100,'purchase',$2)",
    [missing, `opening_grant:${missing}:not-exact`]);
  await expect(claim(missingCode, missing)).rejects.toMatchObject({ message: 'INVITATION_OPENING_DECISION_MISSING' });
  expect((await db.query('SELECT status FROM invitations WHERE code=$1', [missingCode])).rows[0].status).toBe('active');
  expect(await balance(missing)).toBe(0);
});

it('honors existing rejected/rewarded decisions without rewriting old bindings', async () => {
  for (const status of ['rewarded', 'rejected']) {
    const inviter = await profile(), invitee = await profile();
    await db.query('INSERT INTO invitation_records(invite_code,inviter_id,invitee_id,status) VALUES($1,$2,$3,$4)',
      ['historical', inviter, invitee, status]);
    expect(await claim(await code(inviter), invitee)).toMatchObject({ block_reason: 'invitation_already_decided' });
  }
});

it('aggregates all rows and existing rebates; clips caps without clipping the eligible invitee award', async () => {
  const inviter = await profile();
  await settings({ invite_monthly_count_limit: 0, invite_daily_reward_limit: 2000, invite_total_reward_limit: 1010 });
  await db.query("INSERT INTO invitation_records(invite_code,inviter_id,status,inviter_reward)"
    + " SELECT 'old-'||n,$1,'rewarded',1 FROM generate_series(1,1001) n", [inviter]);
  await db.query("INSERT INTO credit_transactions(user_id,amount,type,idempotency_key) VALUES($1,4,'addition','invitation_rebate:historical')", [inviter]);
  expect(await claim(await code(inviter), await profile())).toMatchObject({ inviter_reward: 5, invitee_reward: 30 });
  expect(await claim(await code(inviter), await profile())).toMatchObject({ inviter_reward: 0, invitee_reward: 30, status: 'rewarded' });
});

it('parses settings, respects Beijing day/month windows, IP risk and disabled limits', async () => {
  const inviter = await profile();
  await settings({ invite_inviter_reward: ' 75tail', invite_invitee_reward: 40.9,
    invite_daily_reward_limit: 80, invite_monthly_count_limit: 1 });
  await db.query("INSERT INTO invitation_records(invite_code,inviter_id,status,inviter_reward,created_at)"
    + " VALUES('previous',$1,'rewarded',100,date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai')"
    + " AT TIME ZONE 'Asia/Shanghai' - interval '1 millisecond')", [inviter]);
  expect(await claim(await code(inviter), await profile())).toMatchObject({ inviter_reward: 75, invitee_reward: 40 });
  expect(await claim(await code(inviter), await profile())).toMatchObject({ block_reason: 'invitation_monthly_limit' });
  await settings({ invite_monthly_count_limit: 0, invite_same_ip_hour_limit: 1, invite_same_ip_day_limit: 0 });
  const ip = randomUUID();
  expect(await claim(await code(inviter), await profile(), ip)).toMatchObject({ inviter_reward: 5 });
  expect(await claim(await code(inviter), await profile(), ip)).toMatchObject({ block_reason: 'invitation_ip_limit', risk_level: 'high' });
  await settings({ invite_risk_auto_reject: 'false', invite_daily_reward_limit: 0, invite_total_reward_limit: 0 });
  expect(await claim(await code(inviter), await profile(), ip)).toMatchObject({ status: 'rewarded', risk_level: 'high', inviter_reward: 75 });
  await settings({ invite_inviter_reward: -100, invite_invitee_reward: 'bad' });
  expect(await claim(await code(inviter), await profile())).toMatchObject({ inviter_reward: 0, invitee_reward: 30 });
  await settings({ invite_inviter_reward: 2147483648 });
  await expect(claim(await code(inviter), await profile())).rejects.toThrow('INVITATION_SETTING_OUT_OF_RANGE');
});

// Hold the first real transaction open and observe the second backend waiting for its lock.
async function raceQueries(firstSql: string, first: unknown[], secondSql: string, second: unknown[]) {
  const a = new pg.Client({ connectionString }), b = new pg.Client({ connectionString });
  await a.connect(); await b.connect();
  let pending: Promise<pg.QueryResult> | undefined;
  try {
    await a.query('BEGIN; SET LOCAL ROLE service_role');
    await b.query('SET ROLE service_role; SET statement_timeout=10000');
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const one = (await a.query(firstSql, first)).rows[0];
    pending = b.query(secondSql, second);
    // Capture rejection immediately; it is rethrown on await below, never ignored.
    void pending.catch(() => {});
    let waited = false;
    for (let i = 0; i < 100; i++) {
      waited = (await db.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (waited) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waited).toBe(true);
    await a.query('COMMIT');
    return [one, (await pending).rows[0]];
  } finally {
    await a.query('ROLLBACK');
    await pending?.catch(() => {});
    await a.end(); await b.end();
  }
}
const race = (first: [string, string, string | null], second: [string, string, string | null]) =>
  raceQueries(claimSql, first, claimSql, second);
it('serializes one account across codes and one code across accounts', async () => {
  const inviter = await profile(), invitee = await profile(), first = await code(inviter);
  const rows = await race([first, invitee, null], [await code(inviter), invitee, null]);
  expect(rows.map(row => row.invitee_reward)).toEqual([30, 0]);
  const replay = await race([first, invitee, null], [first, invitee, null]);
  expect(replay.every(row => row.is_idempotent)).toBe(true);
  const other = await profile();
  await expect(race([first, invitee, null], [first, other, null])).rejects.toThrow('invitation code is not active');
});
it('serializes last inviter allowance, month slot, and same IP across disjoint inviters', async () => {
  const inviter = await profile();
  await settings({ invite_daily_reward_limit: 55 });
  let rows = await race([await code(inviter), await profile(), null], [await code(inviter), await profile(), null]);
  expect(rows.map(row => row.inviter_reward)).toEqual([50, 5]);
  const monthInviter = await profile();
  await settings({ invite_monthly_count_limit: 1 });
  rows = await race([await code(monthInviter), await profile(), null], [await code(monthInviter), await profile(), null]);
  expect(rows.map(row => row.status)).toEqual(['rewarded', 'rejected']);
  await settings({ invite_same_ip_hour_limit: 1 });
  const ip = randomUUID();
  rows = await race([await code(await profile()), await profile(), ip], [await code(await profile()), await profile(), ip]);
  expect(rows.map(row => row.status)).toEqual(['rewarded', 'rejected']);
  expect(rows[1].block_reason).toBe('invitation_ip_limit');
});

it('shares the inviter cap with concurrent rebate and makes concurrent rebate replay idempotent', async () => {
  const inviter = await profile(), invitee = await profile();
  await claim(await code(inviter), invitee);
  await settings({ invite_daily_reward_limit: 65 });
  const rebateSql = "SELECT * FROM atomic_apply_invitation_rebate($1,200,'concurrent-rebate',5,65,0,NULL,"
    + "date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')";
  const rows = await raceQueries(rebateSql, [invitee], claimSql, [await code(inviter), await profile(), null]);
  expect(rows[0]).toMatchObject({ status: 'applied', rebate_amount: 10 });
  expect(rows[1]).toMatchObject({ inviter_reward: 5, invitee_reward: 30 });
  const replay = await raceQueries(rebateSql, [invitee], rebateSql, [invitee]);
  expect(replay.every(row => row.status === 'already_applied' && row.rebate_amount === 10)).toBe(true);
  expect(await balance(inviter)).toBe(65);
  expect(Number((await db.query("SELECT count(*) FROM credit_transactions WHERE user_id=$1"
    + " AND idempotency_key='invitation_rebate:concurrent-rebate'", [inviter])).rows[0].count)).toBe(1);
});
it('uses the Beijing daily boundary and serializes the final same-IP daily slot', async () => {
  const inviter = await profile();
  await settings({ invite_daily_reward_limit: 55, invite_same_ip_hour_limit: 0, invite_same_ip_day_limit: 1 });
  await db.query("INSERT INTO invitation_records(invite_code,inviter_id,status,inviter_reward,created_at)"
    + " VALUES('previous-day',$1,'rewarded',100,date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')"
    + " AT TIME ZONE 'Asia/Shanghai' - interval '1 millisecond')", [inviter]);
  expect(await claim(await code(inviter), await profile())).toMatchObject({ inviter_reward: 50 });
  const ip = randomUUID();
  const rows = await race([await code(await profile()), await profile(), ip],
    [await code(await profile()), await profile(), ip]);
  expect(rows.map(row => row.status)).toEqual(['rewarded', 'rejected']);
  expect(rows[1].block_reason).toBe('invitation_ip_limit');
});

it('rolls back rewards, records and code state together on a ledger failure', async () => {
  const inviter = await profile(), invitee = await profile(), value = await code(inviter);
  await db.query("CREATE FUNCTION invite_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test_failure'; END$$;"
    + " CREATE TRIGGER invite_test_fail BEFORE INSERT ON credit_transactions FOR EACH ROW"
    + " WHEN (NEW.idempotency_key LIKE 'invitation_claim:%') EXECUTE FUNCTION invite_test_fail()");
  try {
    await expect(claim(value, invitee)).rejects.toThrow('test_failure');
    expect(await balance(inviter)).toBe(0); expect(await balance(invitee)).toBe(0);
    expect((await db.query('SELECT status FROM invitations WHERE code=$1', [value])).rows[0].status).toBe('active');
    expect(Number((await db.query('SELECT count(*) FROM invitation_records WHERE invitee_id=$1', [invitee])).rows[0].count)).toBe(0);
  } finally { await db.query('DROP TRIGGER invite_test_fail ON credit_transactions; DROP FUNCTION invite_test_fail()'); }
  expect(await claim(value, invitee)).toMatchObject({ status: 'rewarded' });
});

it('replays bigint ledger balances with exact checked integer results, no duplicate money', async () => {
  const inviter = await profile(), invitee = await profile();
  await claim(await code(inviter), invitee);
  const sql = "SELECT * FROM atomic_apply_invitation_rebate($1,200,'test-replay',5)";
  const one = (await db.query(sql, [invitee])).rows[0];
  expect(one).toMatchObject({ status: 'applied', rebate_amount: 10, balance_before: 50, balance_after: 60 });
  expect((await db.query(sql, [invitee])).rows[0]).toMatchObject({ status: 'already_applied', rebate_amount: 10, balance_before: 50, balance_after: 60 });
  expect(await balance(inviter)).toBe(60);
  for (const value of ['2147483647', '-2147483648']) {
    await db.query('UPDATE credit_transactions SET balance_before=$1,balance_after=$1 WHERE id=$2', [value, one.transaction_id]);
    expect((await db.query(sql, [invitee])).rows[0].balance_before).toBe(Number(value));
  }
  await db.query('UPDATE credit_transactions SET balance_after=2147483648 WHERE id=$1', [one.transaction_id]);
  await expect(db.query(sql, [invitee])).rejects.toMatchObject({ code: '22003', message: 'INVITATION_REBATE_BALANCE_OUT_OF_RANGE' });
  expect(await balance(inviter)).toBe(60);
  expect(Number((await db.query("SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND idempotency_key='invitation_rebate:test-replay'", [inviter])).rows[0].count)).toBe(1);
});

it('denies unprivileged RPC sessions and closed invitee/inviter even via service role', async () => {
  const inviter = await profile(), invitee = await profile(), value = await code(inviter);
  for (const role of ['anon', 'authenticated']) {
    const c = new pg.Client({ connectionString }); await c.connect();
    try {
      await c.query(`SET ROLE ${role}`);
      await expect(claim(value, invitee, null, c)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query("SELECT * FROM atomic_apply_invitation_rebate($1,200,'forbidden',5)", [invitee]))
        .rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT * FROM opening_grant_identity_digests')).rejects.toMatchObject({ code: '42501' });
    } finally { await c.end(); }
  }
  for (const id of [inviter, invitee]) {
    await db.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1", [id]);
    await expect(claim(value, invitee)).rejects.toMatchObject({ code: '42501' });
    await db.query("UPDATE profiles SET status='active',is_deleted='false' WHERE id=$1", [id]);
  }
});

async function account(email = `${randomUUID()}@example.test`) {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const session = client(process.env.ERASURE_E_ANON_JWT!);
  const signed = await session.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.user) throw new Error('Synthetic Auth sign-in failed');
  return { user: signed.data.user, session };
}
function caller(actor: Awaited<ReturnType<typeof account>>, privileged = true) {
  return invitationRouter.createCaller({ user: actor.user, headers: new Headers(),
    supabase: actor.session, supabaseAuth: actor.session, supabasePublic: actor.session,
    supabaseAdmin: admin, hasSupabaseAdminPrivileges: privileged, isEmailVerified: true,
    authProvider: 'email', runtimeBudget: createRuntimeBudget() } as Parameters<typeof invitationRouter.createCaller>[0]);
}
async function close(actor: Awaited<ReturnType<typeof account>>) {
  await confirmAccountErasure({ admin, authClient: actor.session, userId: actor.user.id,
    requestId: randomUUID(), nowMs: Date.now() });
  await db.query('UPDATE profiles SET email=NULL,nickname=NULL WHERE id=$1', [actor.user.id]);
  expect((await admin.auth.admin.deleteUser(actor.user.id)).error).toBeNull();
}
it('real Auth -> ensureProfile opening decision -> first claim; same-email re-registration gets 0/0', async () => {
  const inviter = await profile(), actor = await account();
  const value = await code(inviter);
  expect(await caller(actor).claimInvitationCode({ code: value })).toMatchObject({ status: 'claimed', inviteeReward: 30 });
  expect(await balance(actor.user.id)).toBe(130);
  expect((await db.query("SELECT amount FROM credit_transactions WHERE user_id=$1 AND idempotency_key='opening_grant:'||$1::uuid::text",
    [actor.user.id])).rows[0].amount).toBe(100);
  await expect(caller(actor, false).claimInvitationCode({ code: value })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  await close(actor);
  const again = await account(actor.user.email!);
  expect(await caller(again).claimInvitationCode({ code: await code(inviter) })).toMatchObject({ status: 'rejected', inviteeReward: 0, inviterReward: 0 });
  expect(await balance(again.user.id)).toBe(0);
});
it('same synthetic Google subject with changed email gets opening +0 and no invitation rewards', async () => {
  const inviter = await profile(), subject = randomUUID();
  async function google(actor: Awaited<ReturnType<typeof account>>) {
    await db.query("UPDATE auth.identities SET provider='google',provider_id=$2,identity_data="
      + "jsonb_build_object('sub',$2::text,'iss','https://accounts.google.com','email',$3::text) WHERE user_id=$1",
    [actor.user.id, subject, actor.user.email]);
    const verified = (await admin.auth.admin.getUserById(actor.user.id)).data.user as User;
    actor.user = verified;
    return actor;
  }
  const first = await google(await account());
  expect(await caller(first).claimInvitationCode({ code: await code(inviter) })).toMatchObject({ inviteeReward: 30 });
  // Auth's signed session still supplies the original recent-auth proof; server identities are fetched for closure.
  await close(first);
  const again = await google(await account());
  expect(openingGrantDigests(again.user).some(d => d.kind === 'oauth')).toBe(true);
  expect(await caller(again).claimInvitationCode({ code: await code(inviter) })).toMatchObject({ inviteeReward: 0, inviterReward: 0 });
});
