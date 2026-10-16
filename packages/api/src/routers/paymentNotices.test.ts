/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paymentNoticesRouter } from './paymentNotices';
import { logger } from '../lib/logger';
import { resetPlatformSecretCacheForTests } from '../services/platformSecrets/reader';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const ID = '00000000-0000-4000-8000-000000000001';
const ITEM = { id: ID, kind: 'wallet_founder_expiry', state: 'manual', manualReason: 'unknown_unresolved', attempts: 3,
  lastErrorCode: 'PAYMENT_NOTICE_PROVIDER_503', userEmail: 'tester@example.test', createdAt: '2026-10-16T00:00:00.000000Z',
  firstAttemptAt: '2026-10-16T00:00:00.000000Z', resendable: true };

function harness(role: 'admin' | 'user' | 'anonymous', replies: Record<string, { data: unknown; error: unknown }> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      const reply = replies[name] ?? { data: null, error: { code: 'XX000' } };
      return Object.assign(Promise.resolve(reply), { abortSignal: async () => reply });
    },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: ACTOR, email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', userRole: role === 'admin' ? 'admin' : 'user',
    supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: paymentNoticesRouter.createCaller(ctx), calls };
}

beforeEach(() => {
  resetPlatformSecretCacheForTests();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(logger, level).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('non-admins and anonymous callers are refused before any database call', async () => {
  for (const role of ['user', 'anonymous'] as const) {
    const f = harness(role);
    await expect(f.caller.list()).rejects.toMatchObject({ code: role === 'user' ? 'FORBIDDEN' : 'UNAUTHORIZED' });
    await expect(f.caller.resend({ id: ID })).rejects.toMatchObject({ code: role === 'user' ? 'FORBIDDEN' : 'UNAUTHORIZED' });
    expect(f.calls).toEqual([]);
  }
});

it('admin list passes the actor so the database checks the admin again', async () => {
  const f = harness('admin', { payment_notice_admin_list: { data: [ITEM], error: null } });
  expect(await f.caller.list()).toEqual({ items: [ITEM] });
  expect(f.calls).toEqual([['payment_notice_admin_list', { p_actor: ACTOR }]]);
  const denied = harness('admin', { payment_notice_admin_list: { data: null, error: { code: '42501' } } });
  await expect(denied.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('resend refuses clearly when sending is not configured, without claiming the row', async () => {
  const f = harness('admin', {
    payment_notice_prepare: { data: { id: ID, userId: ACTOR, kind: 'wallet_founder_expiry', templateParams: {},
      state: 'manual', attempts: 3, email: 'tester@example.test', erasing: false }, error: null },
    platform_secret_read: { data: null, error: null },
  });
  await expect(f.caller.resend({ id: ID })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED',
    message: 'PAYMENT_NOTICE_NOT_CONFIGURED' });
  expect(f.calls.map(c => c[0])).not.toContain('payment_notice_claim');
});

it('resend rejects malformed ids', async () => {
  await expect(harness('admin').caller.resend({ id: 'not-a-uuid' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
