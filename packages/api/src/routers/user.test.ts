import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { userRouter } from './user';

function createQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    update() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createUserCaller(profileUpdateResult: unknown, updates: unknown[] = [], tables: string[] = []) {
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

      if (['conversations', 'credit_transactions', 'messages'].includes(table)) {
        const result = Promise.resolve({ data: [], error: null, count: 0 });
        return { ...createQueryBuilder(result), gte() { return this; } };
      }

      throw new Error(`Unexpected table ${table}`);
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
    supabaseAdmin: {},
    hasSupabaseAdminPrivileges: false,
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

  it('builds usage stats without querying the module-less ai_usage_logs table', async () => {
    const tables: string[] = [];
    const caller = createUserCaller({ data: null, error: null }, [], tables);

    await expect(caller.getUserUsageStats()).resolves.toMatchObject({
      topModules: [{ name: 'AI 智能对话', count: 0 }],
    });
    expect(tables).not.toContain('ai_usage_logs');
  });

  it('keeps the deprecated duplicate balance endpoint aligned for real zero', async () => {
    const caller = createUserCaller({ data: { credits: 0 }, error: null });

    await expect(caller.getUserCredits()).resolves.toBe(0);
  });

  it.each([
    ['query error', { data: null, error: { code: '42501', message: 'private database detail' } }],
    ['profile missing', { data: null, error: null }],
    ['null balance', { data: { credits: null }, error: null }],
    ['invalid balance', { data: { credits: '0' }, error: null }],
  ])('makes getUserCredits unavailable for %s', async (_name, result) => {
    const caller = createUserCaller(result);

    await expect(caller.getUserCredits()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '余额暂时无法验证，请稍后重试',
    });
  });

  it('makes getUserCredits unavailable when the balance query throws', async () => {
    const caller = createUserCaller(Promise.reject(new TypeError('private network detail')));

    await expect(caller.getUserCredits()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '余额暂时无法验证，请稍后重试',
    });
  });

  it('does not put a fabricated zero balance on the synthetic profile fallback', async () => {
    const caller = createUserCaller({
      data: null,
      error: { code: '57014', message: 'private timeout detail' },
    });

    await expect(caller.getUserProfile()).resolves.toMatchObject({
      credits: null,
    });
  });
});
