import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cleanupState = vi.hoisted(() => ({
  run: vi.fn(),
  getCleanupStats: vi.fn(),
  startScheduledJobRun: vi.fn(),
  finishScheduledJobRun: vi.fn(),
  getLatestScheduledJobRun: vi.fn(),
}));

vi.mock('../services/conversationCleanup', () => {
  class ConversationCleanupService {
    run = cleanupState.run;
    getCleanupStats = cleanupState.getCleanupStats;
  }

  return {
    ConversationCleanupService,
  };
});

vi.mock('../services/scheduledJobRuns', () => ({
  SCHEDULED_JOB_KEYS: {
    conversationCleanup: 'conversation_cleanup',
  },
  startScheduledJobRun: cleanupState.startScheduledJobRun,
  finishScheduledJobRun: cleanupState.finishScheduledJobRun,
  getLatestScheduledJobRun: cleanupState.getLatestScheduledJobRun,
}));

import { adminRouter } from './admin';

function createAwaitableQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    order() {
      return this;
    },
    range() {
      return result;
    },
    or() {
      return this;
    },
    eq() {
      return this;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return result;
    },
  };
}

function createMaybeSingleQueryBuilder(result: Promise<unknown>) {
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
      return this;
    },
    maybeSingle() {
      return result;
    },
  };
}

function createAdminCaller(
  adminSupabase: Record<string, unknown>,
  options: { role?: 'user' | 'admin' } = {},
) {
  const role = options.role ?? 'admin';
  const userScopedSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createSingleQueryBuilder(
          Promise.resolve({
            data: {
              id: 'admin-user',
              role,
              status: 'active',
              nickname: 'Admin',
              email: 'admin@example.com',
            },
            error: null,
          }),
        );
      }

      throw new Error(`Unexpected user-scoped table ${table}`);
    },
  };

  return adminRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userScopedSupabase,
    supabaseAuth: userScopedSupabase,
    supabasePublic: {},
    supabaseAdmin: adminSupabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('adminRouter error sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupState.startScheduledJobRun.mockResolvedValue('run-1');
    cleanupState.finishScheduledJobRun.mockResolvedValue(undefined);
  });

  it('sanitizes getUsers query failures', async () => {
    const adminSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createAwaitableQueryBuilder(
            Promise.resolve({
              data: null,
              error: { message: 'permission denied for table profiles' },
              count: null,
            }),
          );
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.getAllUsers({ limit: 20, offset: 0 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取用户列表失败，请稍后重试',
    });
  });

  it('sanitizes cleanupExpiredConversations failures while preserving job logging', async () => {
    cleanupState.run.mockRejectedValueOnce(new Error('delete from conversations failed'));

    const caller = createAdminCaller({});

    await expect(caller.cleanupExpiredConversations()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '对话清理失败，请稍后重试',
    });

    expect(cleanupState.startScheduledJobRun).toHaveBeenCalledOnce();
    expect(cleanupState.finishScheduledJobRun).toHaveBeenCalledOnce();
  });
});

describe('adminRouter membership eligibility guard', () => {
  const targetUserId = '00000000-0000-4000-8000-000000000111';

  it('rejects admin membership override for active Stripe-managed subscriptions before profile writes', async () => {
    const profileUpdate = vi.fn();
    const subscriptionUpdate = vi.fn();
    const activityLogInsert = vi.fn();

    const adminSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            single() {
              return Promise.resolve({
                data: {
                  membership_level: 'pro',
                  nickname: 'User',
                  email: 'user@example.com',
                },
                error: null,
              });
            },
            update(payload: unknown) {
              profileUpdate(payload);
              return {
                eq() {
                  return this;
                },
                select() {
                  return this;
                },
                single() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        }

        if (table === 'user_subscriptions') {
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
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: 'sub-row-1',
                  metadata: {},
                  stripe_subscription_id: 'sub_test_active',
                  status: 'active',
                  cancel_at_period_end: 'false',
                },
                error: null,
              });
            },
            update(payload: unknown) {
              subscriptionUpdate(payload);
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        if (table === 'user_activity_logs') {
          return {
            insert(payload: unknown) {
              activityLogInsert(payload);
              return Promise.resolve({ error: null });
            },
          };
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.updateUserMembership({
      userId: targetUserId,
      membershipLevel: 'gold',
      reason: 'manual correction',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '该用户存在有效的 Stripe 订阅，禁止在后台直接修改会员等级。请先通过订阅侧调整或取消后再处理。',
    });

    expect(profileUpdate).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(activityLogInsert).not.toHaveBeenCalled();
  });

  it('allows admin membership override for a free user with no active subscription', async () => {
    const profileUpdates: unknown[] = [];
    const activityLogInsert = vi.fn();

    const adminSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            single() {
              return Promise.resolve({
                data: {
                  membership_level: 'free',
                  nickname: 'User',
                  email: 'user@example.com',
                },
                error: null,
              });
            },
            update(payload: unknown) {
              profileUpdates.push(payload);
              return {
                eq() {
                  return this;
                },
                select() {
                  return this;
                },
                single() {
                  return Promise.resolve({
                    data: {
                      id: targetUserId,
                      membership_level: 'pro',
                    },
                    error: null,
                  });
                },
              };
            },
          };
        }

        if (table === 'user_subscriptions' || table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        if (table === 'user_activity_logs') {
          return {
            insert(payload: unknown) {
              activityLogInsert(payload);
              return Promise.resolve({ error: null });
            },
          };
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.updateUserMembership({
      userId: targetUserId,
      membershipLevel: 'pro',
      reason: 'support grant',
    });

    expect(profileUpdates).toEqual([{ membership_level: 'pro' }]);
    expect(activityLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: targetUserId,
      admin_id: 'admin-user',
      action: '会员等级变更: free → pro',
      action_type: 'membership_change',
      details: expect.objectContaining({
        previousLevel: 'free',
        newLevel: 'pro',
        reason: 'support grant',
      }),
    }));
    expect(result).toMatchObject({
      id: targetUserId,
      membership_level: 'pro',
    });
  });

  it('rejects unsupported profile membership levels before admin override writes', async () => {
    const profileUpdate = vi.fn();
    const activityLogInsert = vi.fn();

    const adminSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            single() {
              return Promise.resolve({
                data: {
                  membership_level: 'legacy_platinum',
                  nickname: 'User',
                  email: 'user@example.com',
                },
                error: null,
              });
            },
            update(payload: unknown) {
              profileUpdate(payload);
              return {
                eq() {
                  return this;
                },
                select() {
                  return this;
                },
                single() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        }

        if (table === 'user_subscriptions' || table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        if (table === 'user_activity_logs') {
          return {
            insert(payload: unknown) {
              activityLogInsert(payload);
              return Promise.resolve({ error: null });
            },
          };
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.updateUserMembership({
      userId: targetUserId,
      membershipLevel: 'pro',
      reason: 'support grant',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '会员等级状态暂不支持，请联系管理员处理后再操作。',
    });

    expect(profileUpdate).not.toHaveBeenCalled();
    expect(activityLogInsert).not.toHaveBeenCalled();
  });
});

describe('adminRouter performance stats aggregation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates recent windows locally without re-querying every time bucket', async () => {
    const adminQueries: string[] = [];
    const selectOptions: Array<{ table: string; count?: string; head?: boolean }> = [];

    const recentConversations = [
      { model_id: 'model-a', created_at: '2026-03-29T08:00:00.000Z' },
      { model_id: 'model-a', created_at: '2026-03-27T12:00:00.000Z' },
      { model_id: 'model-b', created_at: '2026-03-20T12:00:00.000Z' },
      { model_id: null, created_at: '2026-03-10T12:00:00.000Z' },
    ];

    const recentMessages = [
      { role: 'user', created_at: '2026-03-29T08:00:00.000Z' },
      { role: 'assistant', created_at: '2026-03-29T08:05:00.000Z' },
      { role: 'assistant', created_at: '2026-03-27T12:00:00.000Z' },
      { role: 'user', created_at: '2026-03-20T12:00:00.000Z' },
      { role: 'assistant', created_at: '2026-03-09T12:00:00.000Z' },
    ];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const state: {
          table: string;
          eqField?: string;
          eqValue?: unknown;
          gteValue?: string;
          head?: boolean;
        } = { table };

        const execute = async () => {
          switch (state.table) {
            case 'conversations':
              if (state.head) {
                return { data: null, error: null, count: 100 };
              }
              return { data: recentConversations, error: null, count: recentConversations.length };
            case 'messages':
              if (state.head && state.eqField === 'role' && state.eqValue === 'user') {
                return { data: null, error: null, count: 120 };
              }
              if (state.head && state.eqField === 'role' && state.eqValue === 'assistant') {
                return { data: null, error: null, count: 180 };
              }
              if (state.head) {
                return { data: null, error: null, count: 300 };
              }
              return { data: recentMessages, error: null, count: recentMessages.length };
            case 'tickets':
              return {
                data: [{ status: 'open' }, { status: 'in_progress' }, { status: 'closed' }, { status: 'open' }],
                error: null,
              };
            case 'ai_models':
              return {
                data: [
                  {
                    id: 'row-a',
                    name: 'Model A',
                    model_id: 'model-a',
                    provider: 'openai',
                    input_token_cost: 1000,
                    output_token_cost: 2000,
                    web_search_cost: 0,
                    is_active: true,
                  },
                  {
                    id: 'row-b',
                    name: 'Model B',
                    model_id: 'model-b',
                    provider: 'anthropic',
                    input_token_cost: 500,
                    output_token_cost: 1000,
                    web_search_cost: 0,
                    is_active: true,
                  },
                ],
                error: null,
              };
            case 'token_stats':
              return {
                data: [
                  {
                    model_used: 'model-a',
                    total_credits: 30,
                    total_cost_usd: '0.030000',
                    input_tokens: 1000,
                    output_tokens: 500,
                    cached_tokens: 100,
                    cache_creation_tokens: 20,
                    created_at: '2026-03-29T08:05:00.000Z',
                  },
                  {
                    model_used: 'model-b',
                    total_credits: 10,
                    total_cost_usd: '0.010000',
                    input_tokens: 200,
                    output_tokens: 100,
                    cached_tokens: 0,
                    cache_creation_tokens: 0,
                    created_at: '2026-03-20T12:00:00.000Z',
                  },
                ],
                error: null,
              };
            case 'ai_usage_logs':
              return {
                data: [
                  { status: 'success', latency_ms: 100, created_at: '2026-03-29T08:05:00.000Z' },
                  { status: 'success', latency_ms: 300, created_at: '2026-03-27T12:00:00.000Z' },
                  { status: 'failed', latency_ms: null, created_at: '2026-03-20T12:00:00.000Z' },
                ],
                error: null,
              };
            default:
              throw new Error(`Unexpected admin table ${state.table}`);
          }
        };

        const builder = {
          select(_columns?: string, options?: { count?: string; head?: boolean }) {
            selectOptions.push({ table: state.table, count: options?.count, head: options?.head });
            state.head = options?.head ?? false;
            return builder;
          },
          eq(field: string, value: unknown) {
            state.eqField = field;
            state.eqValue = value;
            return builder;
          },
          gte(_field: string, value: string) {
            state.gteValue = value;
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getPerformanceStats({ timeRange: '14d' });

    expect(result.conversations).toMatchObject({
      total: 100,
      today: 1,
      thisWeek: 2,
      thisMonth: 4,
      inRange: 3,
    });
    expect(result.messages).toMatchObject({
      total: 300,
      userMessages: 120,
      assistantMessages: 180,
      today: 2,
      thisWeek: 3,
      thisMonth: 5,
      inRange: 4,
    });
    expect(result.tickets).toMatchObject({
      total: 4,
      open: 2,
      inProgress: 1,
      closed: 1,
    });
    expect(result.aiPerformance).toMatchObject({
      totalRequests: 180,
      rangeRequests: 2,
      avgResponseTime: 200,
      p95ResponseTime: 300,
      errorRate: 33.33,
      healthStatus: 'critical',
    });
    expect(result.modelUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'row-a', conversationCount: 2, requestCount: 1 }),
        expect.objectContaining({ id: 'row-b', conversationCount: 1, requestCount: 1 }),
      ]),
    );
    expect(result.dailyChart).toHaveLength(14);
    expect(adminQueries).toHaveLength(10);
    expect(selectOptions.filter((option) => option.head)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'conversations', count: 'planned', head: true }),
        expect.objectContaining({ table: 'messages', count: 'planned', head: true }),
        expect.objectContaining({ table: 'messages', count: 'planned', head: true }),
        expect.objectContaining({ table: 'messages', count: 'planned', head: true }),
      ]),
    );
  });
});

describe('adminRouter dashboard statistics aggregation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses shared datasets for user and conversation rollups', async () => {
    const adminQueries: string[] = [];
    const selectOptions: Array<{ table: string; count?: string; head?: boolean }> = [];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const state: {
          table: string;
          head?: boolean;
          gteValue?: string;
        } = { table };

        const execute = async () => {
          switch (state.table) {
            case 'profiles':
              if (state.head) {
                return { data: null, error: null, count: 0 };
              }
              if (state.gteValue === undefined) {
                return {
                  data: [
                    { id: 'u1', created_at: '2026-03-29T08:00:00.000Z', credits: 10 },
                    { id: 'u2', created_at: '2026-03-27T08:00:00.000Z', credits: 20 },
                    { id: 'u3', created_at: '2026-03-10T08:00:00.000Z', credits: 30 },
                  ],
                  error: null,
                };
              }
              return { data: [], error: null };
            case 'tickets':
              return {
                data: [{ status: 'open' }, { status: 'closed' }, { status: 'in_progress' }],
                error: null,
              };
            case 'invitations':
              return {
                data: [{ status: 'active' }, { status: 'used' }, { status: 'expired' }, { status: 'active' }],
                error: null,
              };
            case 'conversations':
              if (state.head) {
                return { data: null, error: null, count: 40 };
              }
              return {
                data: [
                  { created_at: '2026-03-29T09:00:00.000Z' },
                  { created_at: '2026-03-28T09:00:00.000Z' },
                ],
                error: null,
              };
            case 'credit_transactions':
              return {
                data: [
                  { amount: 50, type: 'addition', created_at: '2026-03-29T09:00:00.000Z' },
                  { amount: -20, type: 'deduction', created_at: '2026-03-28T09:00:00.000Z' },
                  { amount: 30, type: 'purchase', created_at: '2026-03-27T09:00:00.000Z' },
                  { amount: 5, type: 'refund', created_at: '2026-03-26T09:00:00.000Z' },
                ],
                error: null,
              };
            case 'ai_models':
              return {
                data: [
                  { id: 'm1', name: 'Model 1', model_id: 'model-1', is_active: true },
                  { id: 'm2', name: 'Model 2', model_id: 'model-2', is_active: true },
                ],
                error: null,
              };
            default:
              throw new Error(`Unexpected admin table ${state.table}`);
          }
        };

        const builder = {
          select(_columns?: string, options?: { count?: string; head?: boolean }) {
            selectOptions.push({ table: state.table, count: options?.count, head: options?.head });
            state.head = options?.head ?? false;
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
          gte(_field: string, value: string) {
            state.gteValue = value;
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getStatistics();

    expect(result.users).toMatchObject({
      total: 3,
      today: 1,
      thisWeek: 2,
      thisMonth: 3,
    });
    expect(result.conversations).toMatchObject({
      total: 40,
      today: 1,
      thisWeek: 2,
    });
    expect(result.credits.totalInSystem).toBe(60);
    expect(result.invitations).toMatchObject({
      total: 4,
      active: 2,
      used: 1,
      expired: 1,
    });
    expect(result.tickets).toMatchObject({
      total: 3,
      open: 1,
      inProgress: 1,
      closed: 1,
    });
    expect(result.models.activeCount).toBe(2);
    expect(result.trends).toHaveLength(7);
    expect(result.trends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-03-26', additions: 5, deductions: 0 }),
      ]),
    );
    expect(adminQueries).toHaveLength(10);
    expect(selectOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'conversations', count: 'planned', head: true }),
      ]),
    );
  });

  it('filters soft-deleted records out of dashboard statistics queries', async () => {
    const eqCalls: Array<{ table: string; field: string; value: unknown }> = [];

    const adminSupabase = {
      from(table: string) {
        const state: {
          table: string;
          head?: boolean;
        } = { table };

        const execute = async () => {
          switch (state.table) {
            case 'profiles':
              return {
                data: [{ id: 'u1', created_at: '2026-03-29T08:00:00.000Z', credits: 10 }],
                error: null,
              };
            case 'tickets':
              return {
                data: [{ status: 'closed' }],
                error: null,
              };
            case 'invitations':
              return {
                data: [],
                error: null,
              };
            case 'conversations':
              if (state.head) {
                return { data: null, error: null, count: 2 };
              }
              return {
                data: [{ created_at: '2026-03-29T09:00:00.000Z' }],
                error: null,
              };
            case 'credit_transactions':
              return {
                data: [],
                error: null,
              };
            case 'ai_models':
              return {
                data: [],
                error: null,
              };
            default:
              throw new Error(`Unexpected admin table ${state.table}`);
          }
        };

        const builder = {
          select(_columns?: string, options?: { count?: string; head?: boolean }) {
            state.head = options?.head ?? false;
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          eq(field: string, value: unknown) {
            eqCalls.push({ table: state.table, field, value });
            return builder;
          },
          gte() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getStatistics();

    expect(result.tickets).toMatchObject({
      total: 1,
      open: 0,
      inProgress: 0,
      closed: 1,
    });
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { table: 'profiles', field: 'is_deleted', value: false },
        { table: 'tickets', field: 'is_deleted', value: false },
        { table: 'conversations', field: 'is_deleted', value: false },
      ]),
    );
  });
});

describe('adminRouter finance stats runtime billing summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives runtime billing ranges from active model pricing instead of retired system token settings', async () => {
    const selectCalls: Array<{ table: string; columns?: string }> = [];

    const adminSupabase = {
      from(table: string) {
        const state: { table: string; columns?: string } = { table };

        const execute = async () => {
          switch (state.table) {
            case 'credit_transactions':
              return { data: [], error: null };
            case 'credit_packages':
              return { data: [], error: null };
            case 'profiles':
              return { data: [{ credits: 100, created_at: '2026-03-28T08:00:00.000Z' }], error: null };
            case 'ai_models':
              return {
                data: [
                  {
                    id: 'model-a-row',
                    name: 'Claude Sonnet',
                    model_id: 'model-a',
                    provider: 'anthropic',
                    is_active: 'true',
                    input_token_cost: 3000000,
                    output_token_cost: 15000000,
                    input_token_cost_above_200k: 0,
                    output_token_cost_above_200k: 0,
                    web_search_cost: 200000,
                    max_tokens: 8192,
                  },
                  {
                    id: 'model-b-row',
                    name: 'Claude Haiku',
                    model_id: 'model-b',
                    provider: 'anthropic',
                    is_active: 'true',
                    input_token_cost: 800000,
                    output_token_cost: 4000000,
                    input_token_cost_above_200k: 0,
                    output_token_cost_above_200k: 0,
                    web_search_cost: 0,
                    max_tokens: 8192,
                  },
                  {
                    id: 'model-c-row',
                    name: 'Inactive Model',
                    model_id: 'model-c',
                    provider: 'openai',
                    is_active: 'false',
                    input_token_cost: 9000000,
                    output_token_cost: 18000000,
                    input_token_cost_above_200k: 0,
                    output_token_cost_above_200k: 0,
                    web_search_cost: 500000,
                    max_tokens: 8192,
                  },
                ],
                error: null,
              };
            case 'conversations':
              return { data: [], error: null };
            case 'token_stats':
              return { data: [], error: null };
            case 'payment_orders':
              return { data: [], error: null };
            case 'ai_usage_logs':
              return { data: [], error: null };
            case 'billing_history':
              return { data: [], error: null };
            case 'system_settings':
              return {
                data: [
                  { key: 'new_user_credits', value: '120' },
                  { key: 'search_surcharge_credits', value: '7' },
                  { key: 'input_credits_per_1k', value: '999' },
                ],
                error: null,
              };
            default:
              throw new Error(`Unexpected admin table ${state.table}`);
          }
        };

        const builder = {
          select(columns?: string) {
            state.columns = columns;
            selectCalls.push({ table: state.table, columns });
            return builder;
          },
          order() {
            return builder;
          },
          in() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getFinanceStats();

    expect(result.runtimeBilling).toEqual({
      creditsPerUsd: 1000,
      tokenPriceMultiplier: 1.5,
      activeModelCount: 2,
      inputCreditsPer1KRange: { min: 1.2, max: 4.5 },
      outputCreditsPer1KRange: { min: 6, max: 22.5 },
      searchCreditsPer1KRange: { min: 300, max: 300 },
      searchSurchargeCredits: 7,
      newUserCredits: 120,
    });

    expect(selectCalls).toContainEqual({
      table: 'system_settings',
      columns: '*',
    });
  });
});

describe('adminRouter credit adjustments', () => {
  const userId = '00000000-0000-4000-8000-00000000003c';

  function createCreditAdjustmentSupabase(options: {
    currentCredits: number;
    rpcError?: { message: string };
  }) {
    const rpc = vi.fn().mockResolvedValue({
      data: options.rpcError
        ? null
        : [{
            transaction_id: '00000000-0000-4000-8000-0000000000aa',
            balance_before: options.currentCredits,
            balance_after: options.currentCredits,
            amount: 0,
            is_idempotent: false,
          }],
      error: options.rpcError ?? null,
    });
    const activityLogInsert = vi.fn().mockResolvedValue({ data: null, error: null });
    const profileUpdates: unknown[] = [];
    const creditTransactionInserts: unknown[] = [];

    const adminSupabase = {
      rpc,
      from(table: string) {
        if (table === 'profiles') {
          return {
            select() {
              return this;
            },
            update(value: unknown) {
              profileUpdates.push(value);
              return this;
            },
            eq() {
              return this;
            },
            single() {
              return Promise.resolve({
                data: { credits: options.currentCredits },
                error: null,
              });
            },
          };
        }

        if (table === 'user_activity_logs') {
          return {
            insert: activityLogInsert,
          };
        }

        if (table === 'credit_transactions') {
          return {
            insert(value: unknown) {
              creditTransactionInserts.push(value);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    return {
      adminSupabase,
      rpc,
      activityLogInsert,
      profileUpdates,
      creditTransactionInserts,
    };
  }

  it('adds credits with idempotencyKey through the atomic ledger RPC and writes the activity log', async () => {
    const { adminSupabase, rpc, activityLogInsert, profileUpdates, creditTransactionInserts } =
      createCreditAdjustmentSupabase({ currentCredits: 100 });
    rpc.mockResolvedValueOnce({
      data: [{
        transaction_id: '00000000-0000-4000-8000-0000000000aa',
        balance_before: 100,
        balance_after: 125,
        amount: 25,
        is_idempotent: false,
      }],
      error: null,
    });

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.adjustUserCredits({
      userId,
      amount: 25,
      reason: 'manual top-up',
      idempotencyKey: 'admin-request-1',
    });

    expect(rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_user_id: userId,
      p_amount: 25,
      p_type: 'addition',
      p_description: '[Admin] manual top-up',
      p_idempotency_key: `admin_adjustment:admin-user:${userId}:admin-request-1`,
    }));
    expect(profileUpdates).toEqual([]);
    expect(creditTransactionInserts).toEqual([]);
    expect(activityLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: userId,
      admin_id: 'admin-user',
      action: '积分调整: +25',
      action_type: 'credit_adjustment',
      details: expect.objectContaining({
        previousCredits: 100,
        newCredits: 125,
        requestedAdjustment: 25,
        appliedAdjustment: 25,
        reason: 'manual top-up',
      }),
    }));
    expect(result).toEqual({
      previousCredits: 100,
      newCredits: 125,
      adjustment: 25,
    });
  });

  it('deducts credits with idempotencyKey through the atomic ledger RPC and preserves the activity log', async () => {
    const { adminSupabase, rpc, activityLogInsert, profileUpdates, creditTransactionInserts } =
      createCreditAdjustmentSupabase({ currentCredits: 100 });
    rpc.mockResolvedValueOnce({
      data: [{
        transaction_id: '00000000-0000-4000-8000-0000000000ab',
        balance_before: 100,
        balance_after: 60,
        amount: -40,
        is_idempotent: false,
      }],
      error: null,
    });

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.adjustUserCredits({
      userId,
      amount: -40,
      reason: 'manual correction',
      idempotencyKey: 'admin-request-2',
    });

    expect(rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_user_id: userId,
      p_amount: -40,
      p_type: 'deduction',
      p_description: '[Admin] manual correction',
      p_idempotency_key: `admin_adjustment:admin-user:${userId}:admin-request-2`,
    }));
    expect(profileUpdates).toEqual([]);
    expect(creditTransactionInserts).toEqual([]);
    expect(activityLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: '积分调整: -40',
      details: expect.objectContaining({
        previousCredits: 100,
        newCredits: 60,
        requestedAdjustment: -40,
        appliedAdjustment: -40,
      }),
    }));
    expect(result).toEqual({
      previousCredits: 100,
      newCredits: 60,
      adjustment: -40,
    });
  });

  it('caps excessive deductions at zero before calling the atomic ledger RPC', async () => {
    const { adminSupabase, rpc, activityLogInsert } = createCreditAdjustmentSupabase({ currentCredits: 30 });
    rpc.mockResolvedValueOnce({
      data: [{
        transaction_id: '00000000-0000-4000-8000-0000000000ac',
        balance_before: 30,
        balance_after: 0,
        amount: -30,
        is_idempotent: false,
      }],
      error: null,
    });

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.adjustUserCredits({
      userId,
      amount: -100,
      reason: 'cap at zero',
    });

    expect(rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_amount: -30,
      p_type: 'deduction',
    }));
    expect(activityLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: '积分调整: -30',
      details: expect.objectContaining({
        previousCredits: 30,
        newCredits: 0,
        requestedAdjustment: -100,
        appliedAdjustment: -30,
      }),
    }));
    expect(result).toEqual({
      previousCredits: 30,
      newCredits: 0,
      adjustment: -30,
    });
  });

  it('omits the ledger idempotency key when idempotencyKey is not provided', async () => {
    const { adminSupabase, rpc } = createCreditAdjustmentSupabase({ currentCredits: 100 });
    rpc.mockResolvedValueOnce({
      data: [{
        transaction_id: '00000000-0000-4000-8000-0000000000ad',
        balance_before: 100,
        balance_after: 110,
        amount: 10,
        is_idempotent: false,
      }],
      error: null,
    });

    const caller = createAdminCaller(adminSupabase);
    await caller.adjustUserCredits({
      userId,
      amount: 10,
      reason: 'legacy caller without request id',
    });

    expect(rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', {
      p_user_id: userId,
      p_amount: 10,
      p_type: 'addition',
      p_description: '[Admin] legacy caller without request id',
    });
  });

  it('does not call the zero-amount RPC path when the capped adjustment is zero', async () => {
    const { adminSupabase, rpc, activityLogInsert } = createCreditAdjustmentSupabase({ currentCredits: 0 });

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.adjustUserCredits({
      userId,
      amount: -100,
      reason: 'already zero',
    });

    expect(rpc).not.toHaveBeenCalled();
    expect(activityLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: '积分调整: 0',
      details: expect.objectContaining({
        previousCredits: 0,
        newCredits: 0,
        requestedAdjustment: -100,
        appliedAdjustment: 0,
      }),
    }));
    expect(result).toEqual({
      previousCredits: 0,
      newCredits: 0,
      adjustment: 0,
    });
  });

  it('does not write activity logs or legacy credit updates when the atomic ledger RPC fails', async () => {
    const {
      adminSupabase,
      rpc,
      activityLogInsert,
      profileUpdates,
      creditTransactionInserts,
    } = createCreditAdjustmentSupabase({
      currentCredits: 100,
      rpcError: { message: 'permission denied for function atomic_apply_credit_ledger_entry' },
    });

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.adjustUserCredits({
      userId,
      amount: 25,
      reason: 'rpc failure',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '调整用户积分失败，请稍后重试',
    });

    expect(rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_user_id: userId,
      p_amount: 25,
      p_type: 'addition',
      p_description: '[Admin] rpc failure',
    }));
    expect(activityLogInsert).not.toHaveBeenCalled();
    expect(profileUpdates).toEqual([]);
    expect(creditTransactionInserts).toEqual([]);
  });

  it('rejects non-admin callers before credit adjustment logic runs', async () => {
    const { adminSupabase, rpc, activityLogInsert } = createCreditAdjustmentSupabase({ currentCredits: 100 });
    const caller = createAdminCaller(adminSupabase, { role: 'user' });

    await expect(caller.adjustUserCredits({
      userId,
      amount: 10,
      reason: 'not allowed',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'FORBIDDEN',
    });

    expect(rpc).not.toHaveBeenCalled();
    expect(activityLogInsert).not.toHaveBeenCalled();
  });
});

describe('adminRouter lightweight admin dashboards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupState.getCleanupStats.mockResolvedValue({
      stats: [
        { level: 'free', retentionDays: 7, expiredCount: 2 },
        { level: 'pro', retentionDays: 30, expiredCount: 1 },
      ],
      totalExpired: 3,
    });
    cleanupState.getLatestScheduledJobRun.mockResolvedValue({
      id: 'run-1',
      status: 'success',
      started_at: '2026-03-29T10:00:00.000Z',
      summary: { deletedCount: 3 },
      error: null,
    });
  });

  it('searches users without loading the paginated admin user list', async () => {
    const eqCalls: Array<{ field: string; value: unknown }> = [];

    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('profiles');

        const state: {
          search?: string;
          limit?: number;
        } = {};

        const execute = async () => ({
          data: [
            { id: 'u1', email: 'alice@example.com', nickname: 'Alice', avatar_url: null },
            { id: 'u2', email: 'ally@example.com', nickname: 'Ally', avatar_url: null },
          ],
          error: null,
          state,
        });

        const builder = {
          select() {
            return builder;
          },
          or(value: string) {
            state.search = value;
            return builder;
          },
          eq(field: string, value: unknown) {
            eqCalls.push({ field, value });
            return builder;
          },
          order() {
            return builder;
          },
          limit(value: number) {
            state.limit = value;
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.searchUsers({ query: 'ali', limit: 5 });

    expect(result).toEqual([
      { id: 'u1', email: 'alice@example.com', nickname: 'Alice', avatar_url: null },
      { id: 'u2', email: 'ally@example.com', nickname: 'Ally', avatar_url: null },
    ]);
    expect(eqCalls).toEqual([{ field: 'is_deleted', value: false }]);
  });

  it('aggregates package management bootstrap data in one dashboard query', async () => {
    const adminQueries: string[] = [];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const execute = async () => {
          if (table === 'credit_packages') {
            return {
              data: [{ id: 'pkg-1', name: 'Starter', price: 999, sort_order: 1 }],
              error: null,
            };
          }

          if (table === 'membership_plans') {
            return {
              data: [{ id: 'plan-1', name: 'Pro', level: 'pro', sort_order: 1 }],
              error: null,
            };
          }

          throw new Error(`Unexpected admin table ${table}`);
        };

        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getPackagesDashboard();

    expect(result).toEqual({
      packages: [{ id: 'pkg-1', name: 'Starter', price: 999, sort_order: 1 }],
      membershipPlans: [{ id: 'plan-1', name: 'Pro', level: 'pro', sort_order: 1 }],
    });
    expect(adminQueries).toEqual(['credit_packages', 'membership_plans']);
  });

  it('aggregates settings bootstrap data with one settings query and one plans query', async () => {
    const adminQueries: string[] = [];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const execute = async () => {
          if (table === 'system_settings') {
            return {
              data: [
                { key: 'site_name', value: 'Graylum AI' },
                { key: 'maintenance_mode', value: 'false' },
              ],
              error: null,
            };
          }

          if (table === 'membership_plans') {
            return {
              data: [{ id: 'plan-1', name: 'Pro', level: 'pro', sort_order: 1 }],
              error: null,
            };
          }

          throw new Error(`Unexpected admin table ${table}`);
        };

        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getSettingsDashboard();

    expect(result).toEqual({
      systemSettings: {
        site_name: 'Graylum AI',
        maintenance_mode: 'false',
      },
      membershipPlans: [{ id: 'plan-1', name: 'Pro', level: 'pro', sort_order: 1 }],
    });
    expect(adminQueries).toEqual(['system_settings', 'membership_plans']);
    expect(cleanupState.getCleanupStats).not.toHaveBeenCalled();
    expect(cleanupState.getLatestScheduledJobRun).not.toHaveBeenCalled();
  });

  it('fails the settings dashboard instead of rendering defaults when either query fails', async () => {
    const adminSupabase = {
      from(table: string) {
        const result = Promise.resolve(
          table === 'system_settings'
            ? { data: null, error: { code: '42501', message: 'permission denied' } }
            : { data: [], error: null },
        );
        return createAwaitableQueryBuilder(result);
      },
    };

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.getSettingsDashboard()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取系统设置失败，请稍后重试',
    });
  });

  it('rejects null dashboard data instead of treating it as zero plans', async () => {
    const adminSupabase = {
      from(table: string) {
        return createAwaitableQueryBuilder(Promise.resolve({
          data: table === 'credit_packages' ? null : [],
          error: null,
        }));
      },
    };

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.getPackagesDashboard()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取套餐列表失败，请稍后重试',
    });
  });

  it('fails finance stats when the package query fails instead of returning zero packages', async () => {
    const adminSupabase = {
      from(table: string) {
        const result = Promise.resolve(
          table === 'credit_packages'
            ? { data: null, error: { code: '57014', message: 'query timeout' } }
            : { data: [], error: null },
        );
        return createAwaitableQueryBuilder(result);
      },
    };

    const caller = createAdminCaller(adminSupabase);

    await expect(caller.getFinanceStats()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取积分包财务统计失败，请稍后重试',
    });
  });
});

describe('adminRouter remaining performance-sensitive queries', () => {
  it('uses planned count for getAllUsers while keeping pagination metadata', async () => {
    const selectOptions: Array<{ count?: string }> = [];
    const eqCalls: Array<{ field: string; value: unknown }> = [];

    const adminSupabase = {
      from(table: string) {
        if (table !== 'profiles') {
          throw new Error(`Unexpected admin table ${table}`);
        }

        const builder = {
          select(_columns?: string, options?: { count?: string }) {
            selectOptions.push(options ?? {});
            return builder;
          },
          order() {
            return builder;
          },
          range() {
            return Promise.resolve({
              data: [{ id: 'u1', email: 'user@example.com' }],
              error: null,
              count: 42,
            });
          },
          or() {
            return builder;
          },
          eq(field: string, value: unknown) {
            eqCalls.push({ field, value });
            return builder;
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getAllUsers({ limit: 20, offset: 0 });

    expect(result).toMatchObject({
      total: 42,
      hasMore: true,
      users: [{ id: 'u1', email: 'user@example.com' }],
    });
    expect(selectOptions[0]).toMatchObject({ count: 'planned' });
    expect(eqCalls).toEqual([{ field: 'is_deleted', value: false }]);
  });

  it('uses exact count for getAllTransactions and surfaces check-in totals separately', async () => {
    const selectOptions: Array<{ count?: string }> = [];

    const adminSupabase = {
      from(table: string) {
        if (table !== 'credit_transactions' && table !== 'profiles') {
          throw new Error(`Unexpected admin table ${table}`);
        }

        if (table === 'profiles') {
          return {
            select() {
              return this;
            },
            in() {
              return Promise.resolve({
                data: [{ id: 'user-1', email: 'user@example.com', nickname: 'User', avatar_url: null }],
                error: null,
              });
            },
          };
        }

        const state: {
          isStatsQuery: boolean;
          type?: string;
        } = {
          isStatsQuery: false,
        };

        const execute = async () => {
          if (state.isStatsQuery) {
            return {
              data: [
                { type: 'addition', amount: 100 },
                { type: 'checkin', amount: 15 },
                { type: 'deduction', amount: -8 },
                { type: 'purchase', amount: 20 },
                { type: 'refund', amount: 3 },
              ].filter((entry) => !state.type || entry.type === state.type),
              error: null,
            };
          }

          return {
            data: [
              {
                id: 'tx-1',
                user_id: 'user-1',
                amount: 15,
                type: 'checkin',
                description: '每日签到奖励',
                created_at: '2026-03-29T08:00:00.000Z',
              },
            ].filter((entry) => !state.type || entry.type === state.type),
            error: null,
            count: state.type === 'checkin' ? 1 : 295,
          };
        };

        const builder = {
          select(_columns?: string, options?: { count?: string }) {
            selectOptions.push(options ?? {});
            state.isStatsQuery = !options?.count;
            return builder;
          },
          order() {
            return builder;
          },
          range() {
            return builder;
          },
          eq(field: string, value: string) {
            if (field === 'type') {
              state.type = value;
            }
            return builder;
          },
          gte() {
            return builder;
          },
          lte() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getAllTransactions({ limit: 20, offset: 0 });

    expect(result).toMatchObject({
      total: 295,
      hasMore: true,
      stats: {
        totalAdditions: 100,
        totalCheckins: 15,
        totalDeductions: 8,
        totalPurchases: 20,
        totalRefunds: 3,
      },
      transactions: [
        expect.objectContaining({
          id: 'tx-1',
          type: 'checkin',
          profiles: expect.objectContaining({
            id: 'user-1',
            email: 'user@example.com',
          }),
        }),
      ],
    });
    expect(selectOptions[0]).toMatchObject({ count: 'exact' });
  });

  it('returns unfiltered ticket status counts for admin tabs while paginating ticket rows', async () => {
    const eqCalls: Array<{ query: 'paged' | 'counts'; field: string; value: unknown }> = [];
    let ticketQueryCount = 0;

    const adminSupabase = {
      from(table: string) {
        if (table !== 'tickets' && table !== 'profiles' && table !== 'ticket_replies') {
          throw new Error(`Unexpected admin table ${table}`);
        }

        if (table === 'profiles') {
          return {
            select() {
              return this;
            },
            in() {
              return Promise.resolve({
                data: [{ id: 'user-1', email: 'user@example.com', nickname: 'User', avatar_url: null, role: 'user' }],
                error: null,
              });
            },
          };
        }

        if (table === 'ticket_replies') {
          return {
            select() {
              return this;
            },
            in() {
              return this;
            },
            order() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        }

        ticketQueryCount += 1;
        const queryName = ticketQueryCount === 1 ? 'paged' : 'counts';

        const execute = async () => {
          if (queryName === 'paged') {
            return {
              data: [
                {
                  id: 'ticket-closed',
                  user_id: 'user-1',
                  title: 'Closed ticket',
                  description: null,
                  category: 'bug',
                  priority: 'medium',
                  attachments: [],
                  status: 'closed',
                  created_at: '2026-03-29T08:00:00.000Z',
                  updated_at: '2026-03-29T08:00:00.000Z',
                },
              ],
              error: null,
              count: 2,
            };
          }

          return {
            data: [
              { status: 'open' },
              { status: 'closed' },
              { status: 'closed' },
            ],
            error: null,
          };
        };

        const builder = {
          select() {
            return builder;
          },
          eq(field: string, value: unknown) {
            eqCalls.push({ query: queryName, field, value });
            return builder;
          },
          order() {
            return builder;
          },
          range() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getAllTickets({
      status: 'closed',
      category: 'bug',
      limit: 20,
      offset: 0,
    });

    expect(result).toMatchObject({
      total: 2,
      hasMore: false,
      statusCounts: {
        all: 3,
        open: 1,
        in_progress: 0,
        closed: 2,
      },
      tickets: [
        expect.objectContaining({
          id: 'ticket-closed',
          status: 'closed',
        }),
      ],
    });
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { query: 'paged', field: 'is_deleted', value: false },
        { query: 'paged', field: 'status', value: 'closed' },
        { query: 'paged', field: 'category', value: 'bug' },
        { query: 'counts', field: 'is_deleted', value: false },
        { query: 'counts', field: 'category', value: 'bug' },
      ]),
    );
    expect(eqCalls).not.toEqual(
      expect.arrayContaining([
        { query: 'counts', field: 'status', value: 'closed' },
      ]),
    );
  });

  it('reduces user detail stats to shared datasets plus one planned message count', async () => {
    const adminQueries: string[] = [];
    const selectOptions: Array<{ table: string; count?: string; head?: boolean }> = [];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const state: {
          table: string;
          eqValue?: string;
          inValues?: string[];
        } = { table };

        const execute = async () => {
          switch (state.table) {
            case 'profiles':
              return {
                data: {
                  id: 'user-1',
                  email: 'user@example.com',
                  nickname: 'User',
                },
                error: null,
              };
            case 'conversations':
              return {
                data: [{ id: 'c1' }, { id: 'c2' }],
                error: null,
              };
            case 'credit_transactions':
              return {
                data: [{ amount: -20 }, { amount: -30 }],
                error: null,
              };
            case 'tickets':
              return {
                data: [{ id: 't1' }],
                error: null,
              };
            case 'messages':
              return {
                data: null,
                error: null,
                count: 12,
              };
            case 'user_activity_logs':
              return {
                data: [{ id: 'log-1', action: 'role_change' }],
                error: null,
              };
            default:
              throw new Error(`Unexpected admin table ${state.table}`);
          }
        };

        const builder = {
          select(_columns?: string, options?: { count?: string; head?: boolean }) {
            selectOptions.push({ table: state.table, count: options?.count, head: options?.head });
            return builder;
          },
          eq(_field: string, value: string) {
            state.eqValue = value;
            return builder;
          },
          in(_field: string, values: string[]) {
            state.inValues = values;
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          single() {
            return execute();
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getUserDetails({ userId: '11111111-1111-4111-8111-111111111111' });

    expect(result.stats).toMatchObject({
      totalConversations: 2,
      totalMessages: 12,
      totalCreditsSpent: 50,
      totalTickets: 1,
    });
    expect(result.recentActivity).toEqual([{ id: 'log-1', action: 'role_change' }]);
    expect(selectOptions.find((option) => option.table === 'messages')).toMatchObject({
      count: 'planned',
      head: true,
    });
    expect(adminQueries).toEqual([
      'profiles',
      'conversations',
      'credit_transactions',
      'tickets',
      'user_activity_logs',
      'messages',
    ]);
  });

  it('aggregates feature module page bootstrap data in one endpoint', async () => {
    const adminQueries: string[] = [];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const execute = async () => {
          if (table === 'modules') {
            return {
              data: [{ id: 'module-1', active: true, category: 'writing', is_featured: true }],
              error: null,
              count: 1,
            };
          }

          if (table === 'ai_models') {
            return {
              data: [{ id: 'model-1', name: 'Model 1' }],
              error: null,
            };
          }

          throw new Error(`Unexpected admin table ${table}`);
        };

        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          range() {
            return builder;
          },
          eq() {
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return execute().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return execute().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return execute().finally(onFinally);
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.getPromptsDashboard({ limit: 50, offset: 0, activeOnly: false });

    expect(result).toMatchObject({
      modules: [{ id: 'module-1', active: true, category: 'writing', is_featured: true }],
      prompts: [{ id: 'module-1', active: true, category: 'writing', is_featured: true }],
      total: 1,
      hasMore: false,
      models: [{ id: 'model-1', name: 'Model 1' }],
      stats: {
        total: 1,
        active: 1,
        inactive: 0,
        featured: 1,
      },
    });
    expect(adminQueries).toEqual(['modules', 'modules', 'ai_models']);
  });

  it('creates prompt modules by inserting into modules instead of prompts', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('modules');
        const builder = {
          insert(payload: Record<string, unknown>) {
            inserts.push(payload);
            return builder;
          },
          select() {
            return builder;
          },
          single() {
            return Promise.resolve({
              data: { id: '00000000-0000-4000-8000-000000000001', ...inserts[0] },
              error: null,
            });
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    await caller.createPrompt({
      name: 'Module A',
      description: 'Visible in marketplace',
      content: 'Use module A prompt',
      systemPrompt: 'Module A system',
      userPromptTemplate: 'Input: {{input}}',
      category: 'writing',
      platform: 'web',
      features: ['fast'],
      examples: ['example'],
      userQuestions: ['question'],
      icon: 'Wand2',
      imageUrl: 'https://example.com/module.png',
      badgeType: 'new',
      badgeText: 'NEW',
      creditsDisplay: '按实际 token 计费',
      sortOrder: 88,
      isFeatured: true,
      active: true,
    });

    expect(inserts[0]).toMatchObject({
      title: 'Module A',
      description: 'Visible in marketplace',
      prompt_content: 'Use module A prompt',
      system_prompt: 'Module A system',
      user_prompt_template: 'Input: {{input}}',
      category: 'writing',
      platform: 'web',
      features: JSON.stringify(['fast']),
      examples: JSON.stringify(['example']),
      preparation_questions: JSON.stringify(['question']),
      image_url: 'https://example.com/module.png',
      badge_type: 'new',
      badge_text: 'NEW',
      credits_display: '按实际 token 计费',
      sort_order: 88,
      is_featured: true,
      active: true,
    });
    expect(inserts[0]).not.toHaveProperty('is_system');
  });

  it('updates module visibility, featured status, sort order, and prompt fields in modules', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const filters: Array<Record<string, unknown>> = [];
    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('modules');
        const builder = {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return builder;
          },
          eq(column: string, value: unknown) {
            filters.push({ column, value });
            return builder;
          },
          select() {
            return builder;
          },
          single() {
            return Promise.resolve({
              data: { id: '00000000-0000-4000-8000-000000000002' },
              error: null,
            });
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    await caller.updatePrompt({
      id: '00000000-0000-4000-8000-000000000002',
      active: false,
      isFeatured: false,
      sortOrder: 99,
      content: 'Updated module prompt',
      systemPrompt: 'Updated system',
      userPromptTemplate: 'Updated {{input}}',
    });

    expect(updates[0]).toMatchObject({
      active: false,
      is_featured: false,
      sort_order: 99,
      prompt_content: 'Updated module prompt',
      system_prompt: 'Updated system',
      user_prompt_template: 'Updated {{input}}',
    });
    expect(filters).toContainEqual({
      column: 'id',
      value: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('soft-disables modules instead of physically deleting them', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('modules');
        const builder = {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return builder;
          },
          eq() {
            return builder;
          },
          select() {
            return builder;
          },
          single() {
            return Promise.resolve({
              data: { id: '00000000-0000-4000-8000-000000000003' },
              error: null,
            });
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.deletePrompt({ id: '00000000-0000-4000-8000-000000000003' });

    expect(result).toMatchObject({ success: true });
    expect(updates[0]).toMatchObject({ active: false });
  });

  it('batch-updates featured flags as boolean module fields', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const filters: Array<Record<string, unknown>> = [];
    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('modules');
        const builder = {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return builder;
          },
          in(column: string, values: unknown[]) {
            filters.push({ column, values });
            return builder;
          },
          select() {
            return Promise.resolve({
              data: [{ id: '00000000-0000-4000-8000-000000000004' }],
              error: null,
            });
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.batchUpdatePrompts({
      ids: ['00000000-0000-4000-8000-000000000004'],
      patch: {
        isFeatured: false,
      },
    });

    expect(result).toMatchObject({ updatedCount: 1 });
    expect(updates[0]).toMatchObject({ is_featured: false });
    expect(filters).toContainEqual({
      column: 'id',
      values: ['00000000-0000-4000-8000-000000000004'],
    });
  });

  it('batch-sets active as a boolean module field', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('modules');
        const builder = {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return builder;
          },
          in() {
            return builder;
          },
          select() {
            return Promise.resolve({
              data: [{ id: '00000000-0000-4000-8000-000000000005' }],
              error: null,
            });
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.batchSetPromptActive({
      ids: ['00000000-0000-4000-8000-000000000005'],
      active: false,
    });

    expect(result).toMatchObject({ updatedCount: 1, active: false });
    expect(updates[0]).toMatchObject({ active: false });
  });

  it('batch soft-disables modules by setting active=false', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const adminSupabase = {
      from(table: string) {
        expect(table).toBe('modules');
        const builder = {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return builder;
          },
          in() {
            return builder;
          },
          select() {
            return Promise.resolve({
              data: [{ id: '00000000-0000-4000-8000-000000000006' }],
              error: null,
            });
          },
        };

        return builder;
      },
    };

    const caller = createAdminCaller(adminSupabase);
    const result = await caller.batchDeletePrompts({
      ids: ['00000000-0000-4000-8000-000000000006'],
    });

    expect(result).toMatchObject({ disabledCount: 1 });
    expect(updates[0]).toMatchObject({ active: false });
  });
});
