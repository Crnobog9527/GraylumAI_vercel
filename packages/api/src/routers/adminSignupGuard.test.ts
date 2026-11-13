/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { adminRouter } from './admin';

// BOT-GUARD part 3: the admin card «注册赠送防刷» — read, save, who may save, ranges, audit.
type Profile = { id: string; role: string; status: string; is_deleted: string; nickname: string };
const ADMIN: Profile = { id: '00000000-0000-4000-8000-0000000000a1', role: 'admin', status: 'active', is_deleted: 'false', nickname: 'Fixture' };
const TODAY = { day: '2026-11-13', granted: 12, cap: 30, paused: false, ip_limit: 5 };
const DAYS = [
  { day: '2026-11-13', granted: 12, refused_paused: 0, refused_same_ip: 3, refused_daily_cap: 1 },
  { day: '2026-11-12', granted: 30, refused_paused: 2, refused_same_ip: 4, refused_daily_cap: 9 },
];

function fixture(options: { profile?: Profile; upsertError?: { code: string } | null; rpc?: Record<string, unknown> } = {}) {
  const profile = options.profile ?? ADMIN;
  const upsert = vi.fn<(rows: unknown, opts: unknown) => Promise<{ error: { code: string } | null }>>(
    async () => ({ error: options.upsertError ?? null }));
  const audit = vi.fn<(row: unknown) => Promise<{ error: null }>>(async () => ({ error: null }));
  const answers: Record<string, unknown> = { signup_gift_today: TODAY, signup_gift_recent: DAYS, ...options.rpc };
  const rpc = vi.fn(async (fn: string) => ({ data: answers[fn], error: null }));
  const client = {
    from(table: string) {
      if (table === 'profiles') return { select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) };
      if (table === 'system_settings') return { upsert };
      if (table === 'user_activity_logs') return { insert: audit };
      throw new Error(`Unexpected table ${table}`);
    },
    rpc,
  };
  const caller = adminRouter.createCaller({
    headers: new Headers(), user: { id: profile.id }, isEmailVerified: true, authProvider: 'email',
    hasSupabaseAdminPrivileges: true, supabase: client, supabasePublic: client, supabaseAdmin: client,
  } as unknown as Parameters<typeof adminRouter.createCaller>[0]);
  return { caller, upsert, audit, rpc };
}

describe('admin.getSignupGuard', () => {
  it("shows today's count, the three settings and refusals by reason (today and last 7 days)", async () => {
    const { caller, rpc } = fixture();
    await expect(caller.getSignupGuard()).resolves.toEqual({
      day: '2026-11-13', granted: 12, settings: { dailyCap: 30, ipLimit: 5, paused: false },
      refused: { paused: { today: 0, last7Days: 2 }, sameIp: { today: 3, last7Days: 7 }, dailyCap: { today: 1, last7Days: 10 } },
      days: DAYS,
    });
    expect(rpc).toHaveBeenCalledWith('signup_gift_recent', { p_days: 7 });
  });

  it('refuses a non-admin and fails on an unexpected answer', async () => {
    await expect(fixture({ profile: { ...ADMIN, role: 'user' } }).caller.getSignupGuard()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fixture({ rpc: { signup_gift_today: { ...TODAY, ip_limit: 0 } } }).caller.getSignupGuard()).rejects.toThrow();
  });
});

describe('admin.updateSignupGuard', () => {
  const input = { dailyCap: 50, ipLimit: 8, paused: true };

  it('saves all three settings at once and audits who changed what, from what', async () => {
    const { caller, upsert, audit } = fixture();
    await expect(caller.updateSignupGuard(input)).resolves.toEqual({ ok: true, auditRecorded: true });
    expect(upsert).toHaveBeenCalledExactlyOnceWith([
      { key: 'signup_gift_daily_cap', value: 50 }, { key: 'signup_gift_ip_limit', value: 8 }, { key: 'signup_gift_paused', value: true },
    ], { onConflict: 'key' });
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      user_id: ADMIN.id, admin_id: ADMIN.id, action_type: 'signup_gift_settings',
      details: { from: { dailyCap: 30, ipLimit: 5, paused: false }, to: input },
    }));
  });

  it.each([
    ['a daily cap above 100000', { ...input, dailyCap: 100001 }],
    ['a negative daily cap', { ...input, dailyCap: -1 }],
    ['a fractional daily cap', { ...input, dailyCap: 2.5 }],
    ['a network limit of 0', { ...input, ipLimit: 0 }],
    ['a network limit above 50', { ...input, ipLimit: 51 }],
    ['a text pause', { ...input, paused: 'true' }],
    ['an extra field', { ...input, extra: 1 }],
  ])('refuses %s without writing anything', async (_, bad) => {
    const { caller, upsert, audit } = fixture();
    await expect(caller.updateSignupGuard(bad as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('accepts the edges: cap 0 (nobody today), network limit 1 and 50', async () => {
    for (const edge of [{ dailyCap: 0, ipLimit: 1, paused: false }, { dailyCap: 100000, ipLimit: 50, paused: false }]) {
      await expect(fixture().caller.updateSignupGuard(edge)).resolves.toMatchObject({ ok: true });
    }
  });

  it.each([
    ['a banned admin', { ...ADMIN, status: 'banned' }],
    ['a deleted admin', { ...ADMIN, is_deleted: 'true' }],
    ['an ordinary user', { ...ADMIN, role: 'user' }],
  ])('refuses %s without writing anything', async (_, profile) => {
    const { caller, upsert, audit } = fixture({ profile });
    await expect(caller.updateSignupGuard(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('reports a refused write (database policy) as forbidden, and other write failures as errors', async () => {
    await expect(fixture({ upsertError: { code: '42501' } }).caller.updateSignupGuard(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fixture({ upsertError: { code: 'XX000' } }).caller.updateSignupGuard(input)).rejects.toThrow();
  });
});
