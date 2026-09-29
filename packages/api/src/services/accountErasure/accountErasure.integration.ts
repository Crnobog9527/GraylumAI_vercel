/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Run only through packages/db/tests/run-account-erasure-close.mjs (local disposable containers).
import { expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

vi.mock('../redisRateLimiter', () => ({ checkRateLimitOrThrow: vi.fn().mockResolvedValue({ success: true }) }));

import { accountRouter } from '../../routers/account';
import { userRouter } from '../../routers/user';
import { confirmAccountErasure, loadAccountErasurePreview } from './service';
import { REAUTH_REQUIRED_MESSAGE, readVerifiedAuthTime } from './reauth';

const restUrl = process.env.ERASURE_LOCAL_REST!;
const authUrl = process.env.ERASURE_LOCAL_AUTH!;
for (const url of [restUrl, authUrl]) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? '')) throw new Error('Account erasure isolated runner required');
}
const nativeFetch = globalThis.fetch;
// No Supabase gateway locally: route the two API prefixes to their disposable containers.
const localFetch: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== restUrl) throw new Error('Non-local request forbidden');
  const service = target.pathname.startsWith('/auth/v1') ? authUrl : restUrl;
  const next = new URL(target.pathname.replace(/^\/(auth|rest)\/v1/, '') + target.search, service);
  return nativeFetch(next, init);
};
type Client = SupabaseClient;
const client = (key: string): Client => createClient(restUrl, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});
const admin = client(process.env.ERASURE_SERVICE_JWT!);
const anonKey = process.env.ERASURE_ANON_JWT!;
const PASSWORD = 'fixture-password-1';

async function createAccount(label: string, role: 'user' | 'admin' = 'user', nickname: string = label) {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  const { error: profileError } = await admin.from('profiles').insert({
    id: data.user.id, email, nickname, role, status: 'active', membership_level: 'free', credits: 40,
  });
  if (profileError) throw profileError;
  return { id: data.user.id, email };
}

async function signIn(email: string) {
  const session = client(anonKey);
  const { data, error } = await session.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw error ?? new Error('signIn');
  return { session, tokens: data.session };
}

function context(userId: string, session: Client) {
  return {
    headers: new Headers(), user: { id: userId, email_confirmed_at: '2026-09-30T00:00:00Z', app_metadata: {} },
    isEmailVerified: true, authProvider: 'email', supabase: session, supabaseAuth: session, supabasePublic: session,
    supabaseAdmin: admin, hasSupabaseAdminPrivileges: true,
  } as unknown as Parameters<typeof accountRouter.createCaller>[0];
}
const caller = (userId: string, session: Client) => accountRouter.createCaller(context(userId, session));
const userCaller = (userId: string, session: Client) => userRouter.createCaller(context(userId, session));
const creditsOf = async (id: string) =>
  (await admin.from('profiles').select('credits').eq('id', id).single()).data?.credits;
const nicknameOf = async (id: string) =>
  (await admin.from('profiles').select('nickname').eq('id', id).single()).data?.nickname;

it('P1 regression: after the migration a signed-in user still updates their own profile', async () => {
  const user = await createAccount('renamer', 'user', '');
  const { session } = await signIn(user.email);
  // ensureProfile backfills an empty nickname with the user's own JWT (profiles UPDATE trigger path).
  await expect(userCaller(user.id, session).getUserProfile()).resolves.toMatchObject({ id: user.id });
  expect(await nicknameOf(user.id)).toMatch(/^user-/);
  await expect(userCaller(user.id, session).updateUserProfile({ nickname: '新名字' }))
    .resolves.toMatchObject({ nickname: '新名字' });
  const direct = await session.from('profiles').update({ nickname: '直接改' }).eq('id', user.id).select('nickname');
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([{ nickname: '直接改' }]);
  // Open accounts keep both RPC paths: own JWT and service_role.
  const checkin = await session.rpc('claim_daily_checkin', { p_user_id: user.id });
  expect(checkin.error).toBeNull();
  expect(checkin.data).toMatchObject([{ already_claimed: false, reward_credits: 5 }]);
  expect(await creditsOf(user.id)).toBe(45);
  const serviceCheckin = await admin.rpc('claim_daily_checkin', { p_user_id: user.id });
  expect(serviceCheckin.data).toMatchObject([{ already_claimed: true }]);
  const { data: convo } = await admin.from('conversations').insert({ user_id: user.id }).select('id').single();
  expect((await session.rpc('soft_delete_conversation', { p_conversation_id: convo?.id, p_user_id: user.id })).data)
    .toBe(true);
});

it('T09/T11: renewal blocks, fresh password re-auth closes, Auth access and client reads end', async () => {
  const owner = await createAccount('owner');
  const bystander = await createAccount('bystander');
  const { session, tokens } = await signIn(owner.email);
  const other = await signIn(bystander.email);
  expect((await session.from('fixture_notes').insert({ user_id: owner.id, body: 'mine' })).error).toBeNull();
  expect((await other.session.from('fixture_notes').insert({ user_id: bystander.id, body: 'theirs' })).error).toBeNull();
  await admin.from('user_subscriptions').insert({
    user_id: owner.id, stripe_subscription_id: `sub_${owner.id}`, status: 'active', current_period_end: '2026-10-30T00:00:00Z',
  });

  const account = caller(owner.id, session);
  await expect(account.erasurePreview()).resolves.toMatchObject({ credits: 40, subscriptionRenewing: true, closed: false });
  const requestId = crypto.randomUUID();
  await expect(account.erasureConfirm({ requestId, acknowledged: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect((await admin.from('profiles').select('status').eq('id', owner.id).single()).data).toEqual({ status: 'active' });

  await admin.from('user_subscriptions').update({ cancel_at_period_end: 'true' }).eq('user_id', owner.id);
  await expect(account.erasurePreview()).resolves.toMatchObject({ subscriptionRenewing: false });
  await expect(account.erasureConfirm({ requestId, acknowledged: true }))
    .resolves.toMatchObject({ requestId, created: true, authRevoked: true });

  expect((await admin.from('profiles').select('status, is_deleted').eq('id', owner.id).single()).data)
    .toEqual({ status: 'deleted', is_deleted: 'true' });
  // The unexpired JWT can no longer read or write private rows; another account is unaffected.
  expect((await session.from('fixture_notes').select('body')).data).toEqual([]);
  expect((await session.from('user_subscriptions').select('id')).data).toEqual([]);
  expect((await session.from('fixture_notes').insert({ user_id: owner.id, body: 'late' })).error?.code).toBe('42501');
  expect((await other.session.from('fixture_notes').select('body')).data).toEqual([{ body: 'theirs' }]);
  // Auth: refresh and new sign-in are refused; the API rejects the closed account.
  const refresh = await client(anonKey).auth.refreshSession({ refresh_token: tokens.refresh_token });
  expect(refresh.error).not.toBeNull();
  await expect(signIn(owner.email)).rejects.toBeTruthy();
  await expect(account.erasurePreview()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'ACCOUNT_CLOSED: 账号已注销' });
  // SECURITY DEFINER RPCs bypass RLS, so they check closure themselves (P2).
  const { data: convo } = await admin.from('conversations').insert({ user_id: owner.id }).select('id').single();
  const checkinClosed = await session.rpc('claim_daily_checkin', { p_user_id: owner.id });
  expect(checkinClosed.error?.message).toBe('ACCOUNT_CLOSED');
  expect((await admin.rpc('claim_daily_checkin', { p_user_id: owner.id })).error?.message).toBe('ACCOUNT_CLOSED');
  expect(await creditsOf(owner.id)).toBe(40);
  expect((await session.rpc('soft_delete_conversation', { p_conversation_id: convo?.id, p_user_id: owner.id })).data)
    .toBe(false);
  expect((await admin.from('conversations').select('is_deleted').eq('id', convo?.id).single()).data)
    .toEqual({ is_deleted: 'false' });
  // Own profile edits no longer apply; status cannot be revived.
  const renamed = await session.from('profiles').update({ nickname: 'after-close' }).eq('id', owner.id).select('id');
  expect(renamed.data ?? []).toEqual([]);
  expect(await nicknameOf(owner.id)).toBe('owner');
  // Irreversible and idempotent.
  const revive = await admin.from('profiles').update({ status: 'active' }).eq('id', owner.id);
  expect(revive.error?.message).toContain('ACCOUNT_ERASURE_IRREVERSIBLE');
  const again = await admin.rpc('account_erasure_confirm', { p_profile_id: owner.id, p_request_id: crypto.randomUUID() });
  expect(again.data).toMatchObject({ requestId, created: false });
  await expect(loadAccountErasurePreview(admin, owner.id)).resolves.toMatchObject({ closed: true });
});

it('T09: stale and forged authentication are refused without closing the account', async () => {
  const user = await createAccount('stale');
  const { session, tokens } = await signIn(user.email);
  const input = { admin, authClient: session, userId: user.id, requestId: crypto.randomUUID() };
  await expect(confirmAccountErasure({ ...input, nowMs: Date.now() + 11 * 60 * 1000 }))
    .rejects.toMatchObject({ message: REAUTH_REQUIRED_MESSAGE });

  const [header, payload, signature] = tokens.access_token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  claims.amr = [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) + 30 }];
  const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
  await expect(confirmAccountErasure({
    ...input, authClient: client(anonKey), headers: new Headers({ Authorization: `Bearer ${forged}` }), nowMs: Date.now(),
  })).rejects.toMatchObject({ message: REAUTH_REQUIRED_MESSAGE });
  expect((await admin.from('profiles').select('status').eq('id', user.id).single()).data).toEqual({ status: 'active' });
});

it('T09: email codes verify once, expire, and a verified code session can close the account', async () => {
  const user = await createAccount('otp');
  const code = async () => {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
    if (error || !data.properties.email_otp) throw error ?? new Error('generateLink');
    return data.properties.email_otp;
  };
  const first = await code();
  const verifier = client(anonKey);
  const verified = await verifier.auth.verifyOtp({ email: user.email, token: first, type: 'email' });
  expect(verified.error).toBeNull();
  expect(await readVerifiedAuthTime({ authClient: verifier, userId: user.id }))
    .toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  expect((await client(anonKey).auth.verifyOtp({ email: user.email, token: first, type: 'email' })).error).not.toBeNull();

  const expired = await code();
  await new Promise((done) => setTimeout(done, 5500));
  expect((await client(anonKey).auth.verifyOtp({ email: user.email, token: expired, type: 'email' })).error).not.toBeNull();

  await expect(caller(user.id, verifier).erasureConfirm({ requestId: crypto.randomUUID(), acknowledged: true }))
    .resolves.toMatchObject({ created: true });
});

it('admins are refused and concurrent confirmations create exactly one closure', async () => {
  const operator = await createAccount('operator', 'admin');
  const { session } = await signIn(operator.email);
  await expect(caller(operator.id, session).erasureConfirm({ requestId: crypto.randomUUID(), acknowledged: true }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });

  const user = await createAccount('race');
  const results = await Promise.all([1, 2, 3].map(() =>
    admin.rpc('account_erasure_confirm', { p_profile_id: user.id, p_request_id: crypto.randomUUID() })));
  expect(results.map((r) => r.error)).toEqual([null, null, null]);
  expect(results.filter((r) => r.data?.created === true)).toHaveLength(1);
  expect(new Set(results.map((r) => r.data?.requestId)).size).toBe(1);
});
