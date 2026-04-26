import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { invitationRouter, validateInvitationCodeExists } from './invitation';

function createProtectedCaller(supabase: { from(table: string): unknown }) {
  return invitationRouter.createCaller({
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
    supabasePublic: { rpc: () => Promise.resolve({ data: true, error: null }) },
    supabaseAdmin: supabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

function createSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    update() {
      return {
        eq() {
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    eq() {
      return this;
    },
    order() {
      return this;
    },
    maybeSingle() {
      return result;
    },
    single() {
      return result;
    },
  };
}

function createListQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return result;
    },
    in() {
      return result;
    },
  };
}

describe('validateInvitationCodeExists', () => {
  it('returns valid when the public RPC confirms the code exists', async () => {
    const supabase = {
      rpc(fn: string, payload: Record<string, unknown>) {
        expect(fn).toBe('validate_invitation_code');
        expect(payload).toEqual({ input_code: 'ABC123' });

        return Promise.resolve({
          data: true,
          error: null,
        });
      },
    } as any;

    await expect(validateInvitationCodeExists(supabase, 'ABC123')).resolves.toEqual({
      valid: true,
    });
  });

  it('throws NOT_FOUND when the public RPC reports the code as invalid', async () => {
    const supabase = {
      rpc() {
        return Promise.resolve({
          data: false,
          error: null,
        });
      },
    } as any;

    await expect(validateInvitationCodeExists(supabase, 'missing')).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'NOT_FOUND',
      message: 'Invalid or used invitation code.',
    });
  });
});

describe('invitationRouter error sanitization', () => {
  it('sanitizes claimInvitationCode lookup failures', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'invitations') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: null,
              error: { message: 'permission denied for table invitations' },
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase);

    await expect(caller.claimInvitationCode({ code: 'ABC123' })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取邀请码失败，请稍后重试',
    });
  });

  it('sanitizes dashboard settings lookup failures', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'invitations') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                code: 'INVITE123',
                created_at: '2026-03-27T00:00:00.000Z',
              },
              error: null,
            }),
          );
        }

        if (table === 'invitation_records') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [],
              error: null,
            }),
          );
        }

        if (table === 'system_settings') {
          return createListQueryBuilder(
            Promise.resolve({
              data: null,
              error: { message: 'permission denied for table system_settings' },
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase);

    await expect(caller.getMyInvitationDashboard()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取邀请码面板失败，请稍后重试',
    });
  });

  it('aggregates admin invitation dashboard payload', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'invitation_records') {
          const builder = {
            select() {
              return builder;
            },
            order() {
              return builder;
            },
            limit() {
              return builder;
            },
            eq() {
              return builder;
            },
            or() {
              return builder;
            },
            then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
              return Promise.resolve({
                data: [
                  {
                    id: 'record-1',
                    invite_code: 'CODE1',
                    inviter_email: 'a@example.com',
                    invitee_email: 'b@example.com',
                    status: 'rewarded',
                    risk_level: 'low',
                    block_reason: null,
                    inviter_reward: 30,
                    created_at: '2026-03-29T08:00:00.000Z',
                  },
                  {
                    id: 'record-2',
                    invite_code: 'CODE2',
                    inviter_email: 'c@example.com',
                    invitee_email: 'd@example.com',
                    status: 'rejected',
                    risk_level: 'high',
                    block_reason: 'ip_limit',
                    inviter_reward: 0,
                    created_at: '2026-03-28T08:00:00.000Z',
                  },
                ],
                error: null,
              }).then(onFulfilled, onRejected);
            },
            catch(onRejected: (reason: unknown) => unknown) {
              return Promise.resolve({
                data: [],
                error: null,
              }).catch(onRejected);
            },
            finally(onFinally: () => void) {
              return Promise.resolve({
                data: [],
                error: null,
              }).finally(onFinally);
            },
          };

          return builder;
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase);
    const result = await caller.getAdminInvitationsDashboard();

    expect(result.stats).toMatchObject({
      total: 2,
      rewarded: 1,
      rejected: 1,
      pending: 0,
      highRisk: 1,
      totalRewards: 30,
    });
    expect(result.records).toHaveLength(2);
    expect(result.riskDistribution).toEqual([
      expect.objectContaining({ name: '低风险', value: 1 }),
      expect.objectContaining({ name: '中风险', value: 0 }),
      expect.objectContaining({ name: '高风险', value: 1 }),
    ]);
  });
});
