/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// S1-FIX batch 1: real routers -> supabase-js -> local PostgREST -> PostgreSQL with 0144 applied.
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { adminRouter } from './admin';
import { checkinRouter } from './checkin';
import { settingsRouter } from './settings';
import { userRouter } from './user';

const origin = process.env.S1F1_LOCAL_REST!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw new Error('S1-FIX-1 isolated runner required');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000003';
const nativeFetch = globalThis.fetch;
// PostgREST is mounted at / in this small fixture, without a Supabase gateway.
const localFetch: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== origin) throw new Error('Non-local request forbidden');
  target.pathname = target.pathname.replace(/^\/rest\/v1/, '');
  return nativeFetch(target, init);
};
const client = (key: string) => createClient(origin, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});
const service = client(process.env.S1F1_SERVICE_JWT!);
const anon = client(process.env.S1F1_ANON_JWT!);
const context = (id: string, token: string, email = `${id === admin ? 'admin' : id === owner ? 'owner' : 'other'}@example.test`) => {
  const userClient = client(token);
  return {
    headers: new Headers(), user: { id, email, app_metadata: { provider: 'email' }, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email', supabase: userClient, supabaseAuth: userClient,
    supabasePublic: anon, supabaseAdmin: service, hasSupabaseAdminPrivileges: true,
  } as any;
};
const readProfile = async (id: string) =>
  (await service.from('profiles').select('email, nickname, role, status').eq('id', id).single()).data;

it('S1-FIX-1: user nickname save, server-side email sync, banner and check-in settings', async () => {
  const own = userRouter.createCaller(context(owner, process.env.S1F1_OWNER_JWT!));
  expect(await own.updateUserProfile({ nickname: ' router name ' })).toMatchObject({ id: owner, nickname: 'router name' });
  expect((await readProfile(other))?.nickname).toBe('other');
  await expect(own.updateUserProfile({ avatarUrl: 'https://example.com/a.png' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  const moved = userRouter.createCaller(context(owner, process.env.S1F1_OWNER_JWT!, 'owner-moved@example.test'));
  await moved.getUserProfile();
  expect((await readProfile(owner))?.email).toBe('owner-moved@example.test');
  await userRouter.createCaller(context(owner, process.env.S1F1_OWNER_JWT!)).getUserProfile();
  expect((await readProfile(owner))?.email).toBe('owner@example.test');

  const banner = await settingsRouter.createCaller(context(owner, process.env.S1F1_OWNER_JWT!)).getBannerAnnouncement();
  expect(banner).toMatchObject({ title: 'live', description: 'fixture' });
  const status = await checkinRouter.createCaller(context(owner, process.env.S1F1_OWNER_JWT!)).getCheckinStatus();
  expect(status.cycleRewards[1]).toBe(7);
});

it('S1-FIX-1: admin users, audit history, transactions and announcements through service_role', async () => {
  const management = adminRouter.createCaller(context(admin, process.env.S1F1_ADMIN_JWT!));
  await expect(adminRouter.createCaller(context(owner, process.env.S1F1_OWNER_JWT!)).getAllUsers({}))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });

  const users = await management.getAllUsers({ limit: 20, offset: 0 });
  expect(users.users.map((user: any) => user.id).sort()).toEqual([owner, other, admin].sort());
  expect(users.users.every((user: any) => user.last_ip === null && user.last_login_at === null)).toBe(true);

  expect(await management.updateUserStatus({ userId: other, status: 'disabled', reason: 'fixture' }))
    .toMatchObject({ id: other, status: 'disabled' });
  await management.updateUserStatus({ userId: other, status: 'active' });
  expect(await management.updateUserRole({ userId: other, role: 'user' })).toMatchObject({ role: 'user' });
  const logs = await management.getUserActivityLogs({ userId: other, limit: 20, offset: 0 });
  expect(logs.logs.filter((log: any) => log.action_type === 'status_change').length).toBeGreaterThanOrEqual(2);
  expect(logs.logs[0]).toMatchObject({ user: { id: other }, admin: { id: admin } });

  const details = await management.getUserDetails({ userId: other });
  expect(details.profile).toMatchObject({ id: other, email: 'other@example.test', last_ip: null });
  expect(details.recentActivity.length).toBeGreaterThanOrEqual(3);

  const transactions = await management.getAllTransactions({ limit: 20, offset: 0 });
  expect(transactions.total).toBe(2);
  expect(transactions.transactions[0]).not.toHaveProperty('source_id');
  expect(transactions.transactions[0].profiles).toHaveProperty('email');

  const created = await management.createAnnouncement({ title: 'router', content: 'fixture', bannerLink: '/pricing' });
  expect(created.banner_link).toBe('/pricing');
  expect((await management.updateAnnouncement({ id: created.id, title: 'router 2', active: 'false' })).title)
    .toBe('router 2');
  const listed = await management.getAllAnnouncements({ limit: 50, offset: 0 });
  expect(listed.announcements.map((row: any) => row.id)).toContain(created.id);
  expect(await management.deleteAnnouncement({ id: created.id })).toEqual({ success: true });
});
