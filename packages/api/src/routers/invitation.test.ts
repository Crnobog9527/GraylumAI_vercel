import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { invitationRouter, validateInvitationCodeExists } from './invitation';

function createProtectedCaller(supabase: { from(table: string): unknown; rpc?: (fn: string, payload: Record<string, unknown>) => Promise<unknown> }) {
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

function createThenableQueryBuilder(result: unknown) {
  const promise = Promise.resolve(result);
  const builder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    gte() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    in() {
      return promise;
    },
    maybeSingle() {
      return promise;
    },
    single() {
      return promise;
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return promise.then(onFulfilled, onRejected);
    },
    catch(onRejected: (reason: unknown) => unknown) {
      return promise.catch(onRejected);
    },
    finally(onFinally: () => void) {
      return promise.finally(onFinally);
    },
  };

  return builder;
}

function createClaimSupabase(options: {
  invitation?: Record<string, unknown> | null;
  rpcResult?: unknown;
  rpcError?: { message: string } | null;
  settings?: Array<{ key: string; value: unknown }>;
  invitationRecords?: Array<Record<string, unknown>>;
  monthlyCount?: number;
}) {
  const rpc = vi.fn(async (fn: string, payload: Record<string, unknown>) => {
    expect(fn).toBe('atomic_claim_invitation_code');
    if (options.rpcError) {
      return { data: null, error: options.rpcError };
    }

    return {
      data: options.rpcResult ?? [{
        invitation_record_id: 'record-1',
        status: 'rewarded',
        risk_level: 'low',
        inviter_reward: 50,
        invitee_reward: 30,
        is_idempotent: false,
      }],
      error: null,
    };
  });

  const supabase = {
    rpc,
    from(table: string) {
      if (table === 'profiles') {
        return createThenableQueryBuilder({
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

      if (table === 'invitations') {
        return createThenableQueryBuilder({
          data: options.invitation ?? {
            code: 'ABC123',
            created_by: 'inviter-1',
            status: 'active',
            used_by: null,
          },
          error: null,
        });
      }

      if (table === 'system_settings') {
        return createThenableQueryBuilder({
          data: options.settings ?? [
            { key: 'invite_inviter_reward', value: 50 },
            { key: 'invite_invitee_reward', value: 30 },
            { key: 'invite_daily_reward_limit', value: 1000 },
            { key: 'invite_monthly_count_limit', value: 50 },
            { key: 'invite_total_reward_limit', value: 50000 },
            { key: 'invite_same_ip_hour_limit', value: 3 },
            { key: 'invite_same_ip_day_limit', value: 5 },
            { key: 'invite_risk_auto_reject', value: true },
          ],
          error: null,
        });
      }

      if (table === 'invitation_records') {
        return createThenableQueryBuilder({
          data: options.invitationRecords ?? [],
          count: options.monthlyCount ?? 0,
          error: null,
        });
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return { supabase, rpc };
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

  it('delegates successful invitation claims to the atomic service-role RPC', async () => {
    const { supabase, rpc } = createClaimSupabase({});
    const caller = createProtectedCaller(supabase);

    const result = await caller.claimInvitationCode({ code: 'ABC123' });

    expect(result).toEqual({
      status: 'claimed',
      inviterReward: 50,
      inviteeReward: 30,
      riskLevel: 'low',
    });
    expect(rpc).toHaveBeenCalledWith('atomic_claim_invitation_code', {
      p_invitation_code: 'ABC123',
      p_invitee_id: 'user-1',
      p_invitee_email: 'user@example.com',
      p_claim_status: 'rewarded',
      p_risk_level: 'low',
      p_block_reason: null,
      p_inviter_reward: 50,
      p_invitee_reward: 30,
      p_ip_address: null,
      p_user_agent: null,
    });
  });

  it('returns already_claimed when the atomic RPC reports an idempotent replay', async () => {
    const { supabase, rpc } = createClaimSupabase({
      invitation: {
        code: 'ABC123',
        created_by: 'inviter-1',
        status: 'used',
        used_by: 'user-1',
      },
      rpcResult: [{
        invitation_record_id: 'record-1',
        status: 'rewarded',
        risk_level: 'low',
        inviter_reward: 50,
        invitee_reward: 30,
        is_idempotent: true,
      }],
    });
    const caller = createProtectedCaller(supabase);

    await expect(caller.claimInvitationCode({ code: 'ABC123' })).resolves.toEqual({
      status: 'already_claimed',
    });
    expect(rpc).toHaveBeenCalledWith('atomic_claim_invitation_code', expect.objectContaining({
      p_invitation_code: 'ABC123',
      p_inviter_reward: 0,
      p_invitee_reward: 0,
    }));
  });

  it('maps inactive or used invitation RPC failures to NOT_FOUND without granting rewards', async () => {
    const { supabase, rpc } = createClaimSupabase({
      invitation: {
        code: 'ABC123',
        created_by: 'inviter-1',
        status: 'used',
        used_by: 'someone-else',
      },
      rpcError: { message: 'invitation code is not active: ABC123' },
    });
    const caller = createProtectedCaller(supabase);

    await expect(caller.claimInvitationCode({ code: 'ABC123' })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'NOT_FOUND',
      message: '邀请码无效或已使用。',
    });
    expect(rpc).toHaveBeenCalledWith('atomic_claim_invitation_code', expect.objectContaining({
      p_inviter_reward: 0,
      p_invitee_reward: 0,
    }));
  });

  it('rejects self invites before calling the atomic RPC', async () => {
    const { supabase, rpc } = createClaimSupabase({
      invitation: {
        code: 'SELF123',
        created_by: 'user-1',
        status: 'active',
        used_by: null,
      },
    });
    const caller = createProtectedCaller(supabase);

    await expect(caller.claimInvitationCode({ code: 'SELF123' })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '不能使用自己的邀请码。',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes rejected claim decisions to the atomic RPC with zero rewards', async () => {
    const { supabase, rpc } = createClaimSupabase({
      monthlyCount: 50,
    });
    const caller = createProtectedCaller(supabase);

    const result = await caller.claimInvitationCode({ code: 'ABC123' });

    expect(result).toMatchObject({
      status: 'rejected',
      inviterReward: 0,
      inviteeReward: 0,
      riskLevel: 'medium',
    });
    expect(rpc).toHaveBeenCalledWith('atomic_claim_invitation_code', expect.objectContaining({
      p_claim_status: 'rejected',
      p_risk_level: 'medium',
      p_inviter_reward: 0,
      p_invitee_reward: 0,
    }));
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
