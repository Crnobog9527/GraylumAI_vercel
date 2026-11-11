import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger';
import { userRouter } from './user';

const USAGE = { conversations: 4, messages: 31, usageDays: 3 };
const MONTH = { totalEarned: 500, totalSpent: 42, transactionCount: 9, byType: {}, byLedgerType: {} };
type StatsOptions = { rpcErrors?: Record<string, unknown>; rpcCalls?: Array<{ name: string; args: Record<string, unknown> }>; admin?: boolean };

function createUserCaller(
  profileUpdateResult: unknown,
  updates: unknown[] = [],
  tables: string[] = [],
  stats: StatsOptions = {},
) {
  let profilesSingleCallCount = 0;

  const supabase = {
    from(table: string) {
      tables.push(table);
      if (table === 'profiles') {
        return {
          select() {
            return this;
          },
          update(value: unknown) {
            updates.push(value);
            return this;
          },
          eq() {
            return this;
          },
          single() {
            profilesSingleCallCount += 1;
            if (profilesSingleCallCount === 1) {
              return Promise.resolve({
                data: {
                  id: 'user-1',
                  role: 'user',
                  status: 'active',
                  nickname: 'User',
                  email: 'user@example.com',
                },
                error: null,
              });
            }

            return Promise.resolve(profileUpdateResult);
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
  // The service-role client: usage stats are read through two database functions and no table.
  const supabaseAdmin = {
    from(table: string) {
      tables.push(table);
      throw new Error(`Unexpected service-role table ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      stats.rpcCalls?.push({ name, args });
      const error = stats.rpcErrors?.[name] ?? null;
      const data = error ? null : name === 'usage_stats_for_user' ? USAGE : name === 'usage_credit_summary_for_user' ? MONTH : null;
      return Promise.resolve({ data, error });
    },
  };

  return userRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase,
    supabaseAuth: supabase,
    supabasePublic: {},
    supabaseAdmin,
    hasSupabaseAdminPrivileges: stats.admin ?? true,
  } as any);
}

describe('userRouter error sanitization', () => {
  it('sanitizes updateUserProfile failures', async () => {
    const caller = createUserCaller({
      data: null,
      error: { message: 'duplicate key value violates unique constraint profiles_pkey', code: '23505' },
    });

    await expect(
      caller.updateUserProfile({ nickname: 'New Name' }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '更新个人资料失败，请稍后重试',
    });
  });

  it('writes only the trimmed nickname column', async () => {
    const updates: unknown[] = [];
    const caller = createUserCaller({ data: { id: 'user-1', nickname: 'New Name' }, error: null }, updates);

    await expect(caller.updateUserProfile({ nickname: '  New Name  ' })).resolves.toMatchObject({
      nickname: 'New Name',
    });
    expect(updates).toEqual([{ nickname: 'New Name' }]);
  });

  it.each([
    ['avatar URL', { avatarUrl: 'https://example.com/avatar.png' }],
    ['nickname with avatar URL', { nickname: 'New Name', avatarUrl: 'https://example.com/a.png' }],
    ['empty input', {}],
  ])('rejects %s before any profile write', async (_name, input) => {
    const updates: unknown[] = [];
    const caller = createUserCaller({ data: null, error: null }, updates);

    await expect(caller.updateUserProfile(input)).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
    });
    expect(updates).toEqual([]);
  });

  it('rejects blank or overlong nicknames before any profile write', async () => {
    const updates: unknown[] = [];

    for (const nickname of ['   ', 'x'.repeat(81)]) {
      const caller = createUserCaller({ data: null, error: null }, updates);
      await expect(caller.updateUserProfile({ nickname })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(updates).toEqual([]);
  });

  it('reads usage stats from the per-turn core and the ledger functions, never from the retired chat tables', async () => {
    const tables: string[] = [];
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T09:30:00.000Z'));
    try {
      const caller = createUserCaller({ data: null, error: null }, [], tables, { rpcCalls });

      await expect(caller.getUserUsageStats()).resolves.toEqual({
        totalConversations: 4,
        totalMessages: 31,
        monthlyCreditsUsed: 42,
        usageDays: 3,
        topModules: [{ name: 'AI 智能对话', count: 0 }],
      });
    } finally {
      vi.useRealTimers();
    }
    // Only the caller's own profile lookup touches a table; conversations, messages, credit_transactions and ai_usage_logs are not read.
    expect(tables.filter((table) => table !== 'profiles')).toEqual([]);
    expect(rpcCalls).toEqual(expect.arrayContaining([
      { name: 'usage_stats_for_user', args: { p_user_id: 'user-1' } },
      // "本月" is the calendar month in UTC, the same month the credit cards use.
      { name: 'usage_credit_summary_for_user', args: { p_user_id: 'user-1', p_from: '2026-11-01T00:00:00.000Z' } },
    ]));
    expect(rpcCalls).toHaveLength(2);
  });

  it('no longer exposes the duplicate getUserCredits balance endpoint', () => {
    expect(Object.keys(userRouter._def.procedures)).not.toContain('getUserCredits');
  });

  it.each([
    ['query error', { data: null, error: { code: '57014', message: 'private timeout detail' } }],
    ['profile missing', { data: null, error: null }],
  ])('reports the profile as unavailable instead of default membership or name on %s', async (_name, result) => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const caller = createUserCaller(result);

    await expect(caller.getUserProfile()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '个人资料暂时无法读取，请稍后重试',
    });
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logSpy).toHaveBeenCalledWith('auth', 'user_profile_fetch_failed', expect.any(Object));
    expect(logged).not.toContain('user@example.com');
    expect(logged).not.toContain('private timeout detail');
    logSpy.mockRestore();
  });

  it('returns the real profile when the read succeeds', async () => {
    const caller = createUserCaller({
      data: { id: 'user-1', email: 'user@example.com', nickname: '', membership_level: 'pro', role: 'user' },
      error: null,
    });

    await expect(caller.getUserProfile()).resolves.toMatchObject({
      nickname: 'user',
      membership_level: 'pro',
    });
  });

  it.each(['usage_stats_for_user', 'usage_credit_summary_for_user'])(
    'reports usage stats as unavailable instead of zeros when %s cannot be read',
    async (name) => {
      const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const caller = createUserCaller({ data: null, error: null }, [], [], {
        rpcErrors: { [name]: { code: '42501', message: 'private detail for user@example.com' } },
      });

      await expect(caller.getUserUsageStats()).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'SERVICE_UNAVAILABLE',
        message: '使用统计暂时无法读取，请稍后重试',
      });
      expect(logSpy).toHaveBeenCalledWith('auth', 'user_usage_stats_fetch_failed', { code: '42501' });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('user@example.com');
      logSpy.mockRestore();
    },
  );

  it('reports usage stats as unavailable when the service-role client is not configured', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const caller = createUserCaller({ data: null, error: null }, [], [], { admin: false, rpcCalls });

    await expect(caller.getUserUsageStats()).rejects.toMatchObject<Partial<TRPCError>>({ code: 'SERVICE_UNAVAILABLE' });
    expect(rpcCalls).toEqual([]);
    logSpy.mockRestore();
  });
});
