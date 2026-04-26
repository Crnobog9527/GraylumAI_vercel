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

function createUserCaller(profileUpdateResult: { data: unknown; error: unknown }) {
  let profilesSingleCallCount = 0;

  const supabase = {
    from(table: string) {
      if (table === 'profiles') {
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
      caller.updateUserProfile({
        nickname: 'New Name',
        avatarUrl: 'https://example.com/avatar.png',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '更新个人资料失败，请稍后重试',
    });
  });
});
