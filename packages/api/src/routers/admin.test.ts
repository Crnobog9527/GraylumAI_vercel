import { pricedModel } from '../shared/__tests__/modelPriceFixture';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/stripe', () => ({ getStripeClient: () => ({
  accounts: { retrieveCurrent: async () => ({ id: 'acct_fixture' }) },
  balance: { retrieve: async () => ({ livemode: false }) },
}) }));

import { adminRouter } from './admin';

/** The per-turn core read through database functions (services/adminActivity.ts): what an idle site answers. */
const EMPTY_ADMIN_ACTIVITY = {
  conversations: { total: 0, byModel: [], days: [] }, messages: { user: 0, assistant: 0, days: [] },
  calls: { finished: 0, failed: 0, avgMs: null, p95Ms: null },
};
const EMPTY_ADMIN_DASHBOARD = {
  users: { total: 0, today: 0, week: 0, month: 0, credits: 0 }, tickets: { total: 0, open: 0, inProgress: 0, closed: 0 },
  ledger: { byType: {}, spent: 0, days: [] },
};
/** An awaitable `.rpc()` answer that also takes the paging calls of a set-returning function. */
function rpcAnswer(data: unknown, error: unknown = null) {
  const builder = {
    order: () => builder,
    range: () => builder,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve({ data, error }).then(onFulfilled, onRejected),
  };
  return builder;
}
/** `.rpc()` of an admin client whose core functions answer `answers[name]`, or an idle site when the name is not given. */
function adminStatsRpc(answers: Record<string, unknown> = {}, calls: Array<{ name: string; args: Record<string, unknown> }> = []) {
  const idle: Record<string, unknown> = {
    turn_admin_activity: EMPTY_ADMIN_ACTIVITY, admin_dashboard_stats: EMPTY_ADMIN_DASHBOARD, turn_admin_usage_days: [],
  };
  return (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (!Object.hasOwn(idle, name)) throw new Error(`Unexpected admin function ${name}`);
    return rpcAnswer(Object.hasOwn(answers, name) ? answers[name] : idle[name]);
  };
}

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
  if (!adminSupabase.rpc) adminSupabase.rpc = async (name: string) => {
    if (name !== 'pay_common_membership_facts') throw new Error(`Unexpected RPC ${name}`);
    const client = adminSupabase as { from: (table: string) => { select: () => {
      maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }> } } };
    const [sub, order] = await Promise.all(['user_subscriptions', 'payment_orders'].map(table =>
      client.from(table).select().maybeSingle()));
    return { data: { subscriptions: sub.data ? [{ ...sub.data, payment_channel: 'stripe', mapping_state: 'mapped' }] : [],
      latest_order: order.data }, error: sub.error ?? order.error };
  };
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

/** Table reads of an admin client by name; anything else (the retired chat tables included) fails the test. */
function adminStatsTables(tables: Record<string, unknown[]>, reads: Array<{ table: string; filters: unknown[][] }> = []) {
  return (table: string) => {
    if (!Object.hasOwn(tables, table)) throw new Error(`Unexpected admin table ${table}`);
    const read = { table, filters: [] as unknown[][] };
    reads.push(read);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'order', 'range', 'limit']) {
      builder[method] = (...args: unknown[]) => { read.filters.push([method, ...args]); return builder; };
    }
    builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: tables[table], error: null }).then(onFulfilled, onRejected);
    return builder;
  };
}

describe('adminRouter performance stats on the per-turn core', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const activity = {
    conversations: {
      total: 100,
      byModel: [{ model: 'model-a', count: 70 }, { model: 'model-b', count: 30 }],
      days: [
        { date: '2026-03-10', model: 'unknown', count: 1 }, { date: '2026-03-20', model: 'model-b', count: 1 },
        { date: '2026-03-27', model: 'model-a', count: 1 }, { date: '2026-03-29', model: 'model-a', count: 1 },
      ],
    },
    messages: {
      user: 120, assistant: 180,
      days: [
        { date: '2026-03-05', user: 1, assistant: 0 }, { date: '2026-03-18', user: 1, assistant: 0 },
        { date: '2026-03-26', user: 0, assistant: 1 }, { date: '2026-03-29', user: 1, assistant: 1 },
      ],
    },
    calls: { finished: 3, failed: 1, avgMs: 200, p95Ms: 300 },
  };
  const usageDays = [{
    model_used: 'model-b', day: '2026-03-28', requests: 4, total_credits: 8, total_cost_usd: '0.03',
    input_tokens: 20, output_tokens: 10, cached_tokens: 0, cache_creation_tokens: 0,
  }];
  const tables = {
    tickets: [{ status: 'open' }, { status: 'open' }, { status: 'in_progress' }, { status: 'closed' }],
    ai_models: [
      { id: 'row-a', name: 'Model A', model_id: 'model-a', provider: 'openai', config: null, is_active: 'true' },
      { id: 'row-b', name: 'Model B', model_id: 'model-b', provider: 'openai', config: null, is_active: 'true' },
    ],
    // One request the retired path left behind; the per-turn core's four requests come from the usage days above.
    token_stats: [{
      model_used: 'model-a', total_credits: 3, total_cost_usd: '0.010000', input_tokens: 100, output_tokens: 50,
      cached_tokens: 10, cache_creation_tokens: 0, created_at: '2026-03-28T08:00:00.000Z',
    }],
  };

  it('counts conversations, messages and calls from the core functions and never reads the retired chat tables', async () => {
    const reads: Array<{ table: string; filters: unknown[][] }> = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const caller = createAdminCaller({
      rpc: adminStatsRpc({ turn_admin_activity: activity, turn_admin_usage_days: usageDays }, calls),
      from: adminStatsTables(tables, reads),
    });

    const result = await caller.getPerformanceStats({ timeRange: '14d' });

    expect(result.modelUsage[0]?.pricing).toMatchObject({ status: 'unread', label: '未读取', base: null, frozen: null });
    expect(result.modelUsage[0]).not.toHaveProperty('inputTokenCost');
    // Windows start at a UTC day: today 03-29, the week from 03-22, the month from 02-27, the 14-day range from 03-15.
    expect(result.conversations).toEqual({ total: 100, today: 1, thisWeek: 2, thisMonth: 4, inRange: 3 });
    expect(result.messages).toEqual({ total: 300, userMessages: 120, assistantMessages: 180, today: 2, thisWeek: 3, thisMonth: 5, inRange: 4 });
    expect(result.tickets).toEqual({ total: 4, open: 2, inProgress: 1, closed: 1 });
    // One failed call in three is 33.33%: health follows the error rate, not the duration of a whole model call.
    expect(result.aiPerformance).toEqual({
      totalRequests: 180, rangeRequests: 2, avgResponseTime: 200, p95ResponseTime: 300, errorRate: 33.33, cacheHitRate: 7.7,
      healthStatus: 'critical',
    });
    expect(result.modelUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'row-a', conversationCount: 2, requestCount: 1, creditsConsumed: 3, totalCostUsd: 0.01 }),
      // A model-and-day group stands for its four requests, not for one.
      expect.objectContaining({ id: 'row-b', conversationCount: 1, requestCount: 4, creditsConsumed: 8, totalCostUsd: 0.03 }),
    ]));
    expect(result.tokenUsage).toMatchObject({ inputTokens: 120, outputTokens: 60, cacheReadTokens: 10 });
    expect(result.costStats).toMatchObject({ totalCost: 0.04, avgCostPerRequest: 0.008 });
    expect(result.dailyChart).toHaveLength(14);
    expect(result.dailyChart.at(-1)).toEqual({ date: '2026-03-29', conversations: 1, messages: 2, requests: 1 });

    expect(reads.map(read => read.table).sort()).toEqual(['ai_models', 'tickets', 'token_stats']);
    expect(calls).toEqual(expect.arrayContaining([
      // Charts cover 30 days; finished calls cover the chosen range.
      { name: 'turn_admin_activity', args: { p_from: '2026-02-27T12:00:00.000Z', p_to: '2026-03-29T12:01:00.000Z', p_calls_from: '2026-03-15T12:00:00.000Z' } },
      { name: 'turn_admin_usage_days', args: { p_from: '2026-03-15T12:00:00.000Z', p_to: '2026-03-29T12:01:00.000Z', p_daily_from: '2026-03-15T12:00:00.000Z' } },
    ]));
    expect(calls).toHaveLength(2);
  });

  it('is healthy when no call failed, whatever a whole model call takes, and unknown when nothing ran', async () => {
    const slow = { ...activity, calls: { finished: 200, failed: 0, avgMs: 41_000, p95Ms: 95_000 } };
    const busy = createAdminCaller({ rpc: adminStatsRpc({ turn_admin_activity: slow }), from: adminStatsTables(tables) });
    expect((await busy.getPerformanceStats({ timeRange: '7d' })).aiPerformance).toMatchObject({
      avgResponseTime: 41_000, p95ResponseTime: 95_000, errorRate: 0, healthStatus: 'healthy',
    });
    const idle = createAdminCaller({ rpc: adminStatsRpc(), from: adminStatsTables({ ...tables, token_stats: [] }) });
    const result = await idle.getPerformanceStats({ timeRange: '7d' });
    expect(result.aiPerformance).toMatchObject({ totalRequests: 0, avgResponseTime: 0, p95ResponseTime: 0, errorRate: 0, healthStatus: 'healthy' });
    expect(result.conversations).toEqual({ total: 0, today: 0, thisWeek: 0, thisMonth: 0, inRange: 0 });
    expect(result.costStats).toMatchObject({ totalCost: 0, avgCostPerRequest: 0 });
  });

  it.each([
    ['the activity function fails', { turn_admin_activity: null }],
    ['the usage function answers something that is not a list of days', { turn_admin_usage_days: [{ model_used: 'model-a' }] }],
  ])('fails instead of showing zeros when %s', async (_name, answers) => {
    const caller = createAdminCaller({ rpc: adminStatsRpc(answers), from: adminStatsTables(tables) });
    await expect(caller.getPerformanceStats({ timeRange: '14d' })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR', message: '读取性能统计失败，请稍后重试',
    });
  });
});

describe('adminRouter dashboard statistics from the database summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const dashboard = {
    users: { total: 3, today: 1, week: 2, month: 3, credits: 60 },
    tickets: { total: 3, open: 1, inProgress: 1, closed: 1 },
    ledger: {
      byType: {
        addition: { count: 2, amount: 30 }, purchase: { count: 1, amount: 100 }, refund: { count: 1, amount: 5 },
        checkin: { count: 1, amount: 2 }, consumption: { count: 3, amount: -45 }, adjustment: { count: 6, amount: 0 },
      },
      spent: 45,
      days: [{ date: '2026-03-27', granted: 0, spent: 3 }, { date: '2026-03-29', granted: 20, spent: 7 }],
    },
  };
  const activity = {
    ...EMPTY_ADMIN_ACTIVITY,
    conversations: { total: 40, byModel: [], days: [{ date: '2026-03-25', model: 'model-b', count: 1 }, { date: '2026-03-29', model: 'model-a', count: 2 }] },
  };
  const tables = {
    profiles: [{ id: 'u1', email: 'u1@example.com', nickname: 'U1', avatar_url: null, role: 'user', credits: 30, created_at: '2026-03-29T08:00:00.000Z' }],
    ai_models: [{ id: 'm1', name: 'Model A', model_id: 'model-a', is_active: 'true' }],
  };

  it('takes users, tickets and the ledger from the summary and conversations from the core, with no whole-table read', async () => {
    const reads: Array<{ table: string; filters: unknown[][] }> = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const caller = createAdminCaller({
      rpc: adminStatsRpc({ admin_dashboard_stats: dashboard, turn_admin_activity: activity }, calls),
      from: adminStatsTables(tables, reads),
    });

    const result = await caller.getStatistics();

    expect(result.users).toMatchObject({ total: 3, today: 1, thisWeek: 2, thisMonth: 3 });
    expect(result.users.recentUsers).toHaveLength(1);
    expect(result.conversations).toEqual({ total: 40, today: 2, thisWeek: 3 });
    expect(result.tickets).toEqual({ total: 3, open: 1, inProgress: 1, closed: 1 });
    // Spend is credits actually charged (the core writes them as 'consumption'); reservations are adjustments and are not spend.
    expect(result.credits).toEqual({
      totalInSystem: 60,
      transactions: { totalDeductions: 45, totalAdditions: 30, totalCheckins: 2, totalPurchases: 100, totalRefunds: 5 },
    });
    expect(result.models).toMatchObject({ activeCount: 1 });
    expect(result.trends).toHaveLength(7);
    expect(result.trends.at(-1)).toMatchObject({ date: '2026-03-29', additions: 20, deductions: 7 });
    expect(result.trends.at(-3)).toMatchObject({ date: '2026-03-27', additions: 0, deductions: 3 });
    expect(result.trends.at(-2)).toMatchObject({ date: '2026-03-28', additions: 0, deductions: 0 });
    expect(result.systemHealth).toBe('attention');

    // Only the two short user lists and the active models are read as rows; soft-deleted profiles stay out of the lists.
    expect(reads.map(read => read.table).sort()).toEqual(['ai_models', 'profiles', 'profiles']);
    for (const read of reads.filter(item => item.table === 'profiles')) {
      expect(read.filters).toContainEqual(['eq', 'is_deleted', false]);
      expect(read.filters.some(filter => filter[0] === 'limit')).toBe(true);
    }
    expect(calls).toEqual(expect.arrayContaining([
      { name: 'admin_dashboard_stats', args: { p_today: '2026-03-29T00:00:00.000Z', p_week: '2026-03-22T12:00:00.000Z', p_month: '2026-03-01T00:00:00.000Z' } },
      { name: 'turn_admin_activity', args: { p_from: '2026-03-22T12:00:00.000Z', p_to: '2026-03-29T12:01:00.000Z', p_calls_from: '2026-03-22T12:00:00.000Z' } },
    ]));
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['the summary cannot be read', { admin_dashboard_stats: null }],
    ['the summary is malformed', { admin_dashboard_stats: { ...dashboard, users: { total: '3' } } }],
    ['the conversations cannot be read', { turn_admin_activity: null }],
  ])('fails instead of showing zeros when %s', async (_name, answers) => {
    const caller = createAdminCaller({ rpc: adminStatsRpc(answers), from: adminStatsTables(tables) });
    await expect(caller.getStatistics()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR', message: '读取后台统计失败，请稍后重试',
    });
  });
});

describe('adminRouter finance stats runtime billing summary', () => {
  const financeTables = [
    'credit_transactions',
    'credit_packages',
    'profiles',
    'ai_models',
    // The per-turn core is read through two database functions (services/adminActivity.ts), not the retired chat tables.
    'turn_admin_activity',
    'token_stats',
    'payment_orders',
    'turn_admin_usage_days',
    'billing_history',
    'system_settings',
  ] as const;
  type FinanceTable = typeof financeTables[number];
  const financeFunctions: readonly string[] = ['turn_admin_activity', 'turn_admin_usage_days'];

  function createValidFinanceData(): Record<FinanceTable, unknown[]> {
    return {
      credit_transactions: [{
        amount: 25,
        type: 'addition',
        created_at: '2026-03-29T08:00:00.000Z',
        description: 'grant',
      }],
      credit_packages: [{
        id: 'package-1',
        name: 'Starter',
        price: 1000,
        credits_amount: 1200,
        active: 'true',
      }],
      profiles: [{ credits: 100, created_at: '2026-03-28T08:00:00.000Z' }],
      ai_models: [{
        id: 'model-row-1',
        name: 'Model A',
        model_id: 'model-a',
        provider: 'openai',
        is_active: 'true',
        input_token_cost: 1000000,
        output_token_cost: 2000000,
        input_token_cost_above_200k: 0,
        output_token_cost_above_200k: 0,
        web_search_cost: 0,
        max_tokens: 8192,
      }],
      turn_admin_activity: {
        conversations: { total: 1, byModel: [{ model: 'model-a', count: 1 }], days: [{ date: '2026-03-29', model: 'model-a', count: 1 }] },
        messages: { user: 1, assistant: 1, days: [{ date: '2026-03-29', user: 1, assistant: 1 }] },
        calls: { finished: 1, failed: 0, avgMs: 1200, p95Ms: 1200 },
      } as unknown as unknown[],
      token_stats: [{
        model_used: 'model-a',
        total_credits: 5,
        total_cost_usd: '0.125000',
        cached_tokens: 0,
        created_at: '2026-03-29T08:00:00.000Z',
      }],
      payment_orders: [{
        amount_total: 1500,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        created_at: '2026-03-29T08:00:00.000Z',
      }],
      // No call of the per-turn core by default: the one request is the retired path's token_stats row above.
      turn_admin_usage_days: [],
      billing_history: [{
        operation_type: 'refund',
        amount: 3,
        created_at: '2026-03-29T08:00:00.000Z',
        metadata: {},
      }],
      system_settings: [
        { key: 'new_user_credits', value: '120' },
        { key: 'search_surcharge_credits', value: '7' },
        { key: 'billing_credits_per_usd', value: '1000' },
        { key: 'billing_token_price_multiplier', value: '1.5' },
      ],
    };
  }

  function createFinanceStatsSupabase(
    overrides: Partial<Record<FinanceTable, unknown>> = {},
  ) {
    const defaultData = createValidFinanceData();

    return {
      rpc(name: string) {
        if (!financeFunctions.includes(name)) throw new Error(`Unexpected finance function ${name}`);
        return this.from(name, true);
      },
      from(table: string, viaFunction = false) {
        if (!financeTables.includes(table as FinanceTable) || financeFunctions.includes(table) !== viaFunction) {
          throw new Error(`Unexpected finance table ${table}`);
        }

        const data = Object.prototype.hasOwnProperty.call(overrides, table)
          ? overrides[table as FinanceTable]
          : defaultData[table as FinanceTable];
        let from = 0;
        let to = Number.MAX_SAFE_INTEGER;
        const result = () => Promise.resolve({
          data: Array.isArray(data) ? data.slice(from, to + 1) : data,
          error: null,
        });
        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          in() {
            return builder;
          },
          range(start: number, end: number) {
            from = start;
            to = end;
            return builder;
          },
          then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
            return result().then(onFulfilled, onRejected);
          },
          catch(onRejected: (reason: unknown) => unknown) {
            return result().catch(onRejected);
          },
          finally(onFinally: () => void) {
            return result().finally(onFinally);
          },
        };

        return builder;
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(financeTables)(
    'fails closed when %s returns null data without a query error',
    async (table) => {
      const caller = createAdminCaller(createFinanceStatsSupabase({ [table]: null }));

      await expect(caller.getFinanceStats()).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'INTERNAL_SERVER_ERROR',
      });
    },
  );

  it('fails closed when a finance source returns a non-array payload', async () => {
    const caller = createAdminCaller(createFinanceStatsSupabase({
      turn_admin_usage_days: { model_used: 'not-an-array' },
    }));

    await expect(caller.getFinanceStats()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取财务统计失败，请稍后重试',
    });
  });

  it.each([
    ['wrong numeric type', '25'],
    ['non-finite number', Number.POSITIVE_INFINITY],
  ])('fails closed for a malformed finance amount: %s', async (_caseName, amount) => {
    const caller = createAdminCaller(createFinanceStatsSupabase({
      credit_transactions: [{
        amount,
        type: 'addition',
        created_at: '2026-03-29T08:00:00.000Z',
      }],
    }));

    await expect(caller.getFinanceStats()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取财务统计失败，请稍后重试',
    });
  });

  it('fails closed for an invalid required finance date', async () => {
    const caller = createAdminCaller(createFinanceStatsSupabase({
      token_stats: [{ model_used: 'model-a', total_credits: 5, total_cost_usd: '0.125000', cached_tokens: 0, created_at: 'not-a-date' }],
    }));

    await expect(caller.getFinanceStats()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取财务统计失败，请稍后重试',
    });
  });

  it.each(['', 'not-a-number', null])(
    'fails closed when an existing billing setting is invalid: %#',
    async (value) => {
      const caller = createAdminCaller(createFinanceStatsSupabase({
        system_settings: [{ key: 'billing_credits_per_usd', value }],
      }));

      await expect(caller.getFinanceStats()).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'INTERNAL_SERVER_ERROR',
        message: '读取财务统计失败，请稍后重试',
      });
    },
  );

  it.each(['consumption', 'adjustment'])('accepts canonical %s rows without counting reservations as spend', async (type) => {
    const result = await createAdminCaller(createFinanceStatsSupabase({
      credit_transactions: [{ amount: -20, type, description: 'BILL2 canonical row', created_at: '2026-03-29T08:00:00.000Z' }],
    })).getFinanceStats();
    // The legacy overview consumes canonical usage once, never the reserve/release amount.
    expect(result.financeOverview.creditsConsumed).toBe(5);
    expect(result.transactions.totalAdditions).toBe(0);
  });

  it('accepts unknown BILL2 cache usage without losing recorded cost or fabricating usage', async () => {
    const rows = [{ model_used: 'model-a', total_credits: 3, total_cost_usd: '0.003', cached_tokens: null, created_at: '2026-03-29T08:00:00.000Z' }];
    const result = await createAdminCaller(createFinanceStatsSupabase({ token_stats: rows })).getFinanceStats();
    expect(result.modelStats).toEqual(expect.arrayContaining([expect.objectContaining({ costUsd: 0.003 })]));
    expect(rows[0].cached_tokens).toBeNull();
  });

  it('accepts the saved empty provider-price setting without treating it as a scalar billing setting', async () => {
    const result = await createAdminCaller(createFinanceStatsSupabase({
      system_settings: [
        { key: 'billing_provider_prices', value: { version: 1, entries: [] } },
        { key: 'billing_credits_per_usd', value: 100 },
        { key: 'billing_token_price_multiplier', value: 3 },
      ],
    })).getFinanceStats();
    expect(result.runtimeBilling).toMatchObject({ creditsPerUsd: 100, tokenPriceMultiplier: 3 });
    expect(result.financeOverview.recordedCostUsd).toBe(0.125);
  });

  it('accepts a renamed model with a refreshed snapshot and the retained manual costs', async () => {
    const modelId = 'openai/gpt-6.1-sol';
    const config = pricedModel().config;
    config.pricing.model = modelId;
    config.reasoning.catalog.model = modelId;
    const result = await createAdminCaller(createFinanceStatsSupabase({
      ai_models: [{ id: 'renamed-model', name: modelId, model_id: modelId, provider: 'openrouter',
        is_active: true, max_tokens: 4096, input_token_cost: 200000, output_token_cost: 400000,
        input_token_cost_above_200k: 300000, output_token_cost_above_200k: 600000, web_search_cost: 50000,
        config,
      }],
    })).getFinanceStats();
    expect(result.modelStats).toEqual([expect.objectContaining({ modelId, pricing: expect.objectContaining({ status: 'ready' }) })]);
    expect(result.modelStats[0]).not.toHaveProperty('inputTokenCost');
    expect(result.financeOverview.recordedCostUsd).toBe(0.125);
  });

  it('counts checkins and exposes unknown transaction types without failing or double counting spend', async () => {
    const created_at = '2026-03-29T08:00:00.000Z';
    const rows = [
      { type: 'addition', amount: 25, created_at }, { type: 'purchase', amount: 100, created_at },
      { type: 'checkin', amount: 7, created_at }, { type: 'future_reward', amount: 11, created_at },
      { type: 'future_reward', amount: -2, created_at }, { type: '__proto__', amount: 3, created_at },
      ...['deduction', 'consumption', 'adjustment', 'refund'].map(type => ({ type, amount: -20, created_at })),
    ];
    const result = await createAdminCaller(createFinanceStatsSupabase({ credit_transactions: rows })).getFinanceStats();
    expect(result.transactions).toMatchObject({ totalAdditions: 25, totalCheckins: 7, totalPurchases: 100,
      totalDeductions: 5, totalRefunds: 3, unknownTypeCount: 3,
      unknownTypes: { future_reward: 2, ['__proto__']: 1 } });
    expect(result.financeOverview).toMatchObject({ creditsGiven: 32, creditsPurchased: 100, netCreditsFlow: 127 });
    expect(result.dailyChart.find(day => day.date === '2026-03-29')).toMatchObject({ additions: 25, checkins: 7,
      purchases: 100, deductions: 5, unknownTypeCount: 3 });
  });

  it('preserves an unfamiliar model active value without counting it as active', async () => {
    const result = await createAdminCaller(createFinanceStatsSupabase({ ai_models: [
      { id: 'future-model', name: 'Future', model_id: 'future/model', provider: 'openrouter', is_active: 'archived',
        max_tokens: 4096, input_token_cost: 1, output_token_cost: 2, input_token_cost_above_200k: 0,
        output_token_cost_above_200k: 0, web_search_cost: 0 },
    ] })).getFinanceStats();
    expect(result.runtimeBilling).toMatchObject({ activeModelCount: 0, unknownModelActiveCount: 1 });
    expect(result.modelStats[0].isActive).toBe('archived');
  });

  it('preserves an unfamiliar unconstrained package active value and counts it separately', async () => {
    const result = await createAdminCaller(createFinanceStatsSupabase({ credit_packages: [
      { id: 'future-package', name: 'Future', price: 100, credits_amount: 10, active: 'archived' },
    ] })).getFinanceStats();
    expect(result.packages).toMatchObject({ totalPackages: 1, activePackages: 0, unknownActiveCount: 1,
      packages: [expect.objectContaining({ active: 'archived' })] });
  });

  it.each(['', '   ', null, 123])('still rejects an invalid transaction type: %#', async type => {
    const caller = createAdminCaller(createFinanceStatsSupabase({ credit_transactions: [
      { amount: 7, type, created_at: '2026-03-29T08:00:00.000Z' },
    ] }));
    await expect(caller.getFinanceStats()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('accepts genuinely empty datasets and keeps missing-setting fallbacks', async () => {
    const emptyActivity = {
      conversations: { total: 0, byModel: [], days: [] }, messages: { user: 0, assistant: 0, days: [] },
      calls: { finished: 0, failed: 0, avgMs: null, p95Ms: null },
    };
    const emptyOverrides = Object.fromEntries(
      financeTables.map((table) => [table, table === 'turn_admin_activity' ? emptyActivity : []]),
    ) as Partial<Record<FinanceTable, unknown>>;
    const caller = createAdminCaller(createFinanceStatsSupabase(emptyOverrides));

    const result = await caller.getFinanceStats();

    expect(result.transactions).toEqual({
      totalAdditions: 0,
      totalDeductions: 0,
      totalPurchases: 0,
      totalRefunds: 0,
      totalCheckins: 0,
      unknownTypeCount: 0,
      unknownTypes: {},
      todayTransactions: 0,
      weekTransactions: 0,
      monthTransactions: 0,
    });
    expect(result.users).toEqual({
      totalUsers: 0,
      totalCreditsInSystem: 0,
      averageCreditsPerUser: 0,
      newUsersThisMonth: 0,
      newUsersThisWeek: 0,
    });
    expect(result.packages).toEqual({
      totalPackages: 0,
      activePackages: 0,
      unknownActiveCount: 0,
      packages: [],
    });
    expect(result.modelStats).toEqual([]);
    expect(result.dailyChart).toHaveLength(30);
    expect(result.runtimeBilling).toMatchObject({
      creditsPerUsd: null,
      tokenPriceMultiplier: null,
      billingUnitSource: { creditsPerUsd: 'default', defaultMultiplier: 'default' },
      searchSurchargeCredits: null,
      newUserCredits: 500,
    });
  });

  it('adds the per-turn core to what the retired path left: credits, cost and requests per model, days only for the chart', async () => {
    const unknownTokens = { input_tokens: null, output_tokens: null, cached_tokens: null, cache_creation_tokens: null };
    const caller = createAdminCaller(createFinanceStatsSupabase({
      turn_admin_usage_days: [
        // Everything older than the 30-day chart comes folded into one row per model (no day).
        { model_used: 'model-a', day: null, requests: 10, total_credits: 40, total_cost_usd: '0.5', ...unknownTokens },
        { model_used: 'model-a', day: '2026-03-28', requests: 3, total_credits: 12, total_cost_usd: '0.25', ...unknownTokens },
      ],
    }));

    const result = await caller.getFinanceStats();

    // 5 credits of the retired path's row, plus 40 and 12 of the core.
    expect(result.transactions.totalDeductions).toBe(57);
    expect(result.dailyChart.find(day => day.date === '2026-03-28')?.deductions).toBe(12);
    expect(result.dailyChart.find(day => day.date === '2026-03-29')?.deductions).toBe(5);
    expect(result.dailyChart.reduce((sum, day) => sum + day.deductions, 0)).toBe(17);
    // A group stands for its requests; the folded row counts in the total only.
    expect(result.apiStats).toEqual({ totalRequests: 14, totalConversations: 1, messagesThisMonth: 4, messagesThisWeek: 4 });
    expect(result.modelStats[0]).toMatchObject({ conversationCount: 1, requestCount: 14, creditsConsumed: 57, costUsd: 0.875 });
    expect(result.financeOverview).toMatchObject({ recordedCostUsd: 0.875, creditsConsumed: 57 });
  });

  it('preserves the established successful finance result shape and calculations', async () => {
    const caller = createAdminCaller(createFinanceStatsSupabase());

    const result = await caller.getFinanceStats();

    expect(result).toMatchObject({
      transactions: {
        totalAdditions: 25,
        totalDeductions: 5,
        totalRefunds: 3,
      },
      users: {
        totalUsers: 1,
        totalCreditsInSystem: 100,
      },
      packages: {
        totalPackages: 1,
        activePackages: 1,
      },
      apiStats: {
        totalRequests: 1,
        totalConversations: 1,
      },
      financeOverview: {
        paidRevenueCents: 1500,
        recordedCostUsd: 0.125,
        creditsConsumed: 5,
        creditsGiven: 25,
      },
      runtimeBilling: {
        creditsPerUsd: 1000,
        tokenPriceMultiplier: 1.5,
        searchSurchargeCredits: 7,
        newUserCredits: 120,
      },
    });
  });

  it('includes later pages of recorded cost and paid USD orders without converting another currency', async () => {
    const created_at = '2026-03-29T08:00:00.000Z';
    const tokenRows = Array.from({ length: 1001 }, () => ({
      model_used: 'model-a', total_credits: 1, total_cost_usd: '0.000001',
      cached_tokens: 0, created_at,
    }));
    const usdOrders = Array.from({ length: 1001 }, () => ({
      amount_total: 1, currency: 'usd', status: 'completed', payment_status: 'paid', created_at,
    }));
    const otherCurrencyOrder = {
      amount_total: 100000, currency: 'cny', status: 'completed', payment_status: 'paid', created_at,
    };
    const result = await createAdminCaller(createFinanceStatsSupabase({
      token_stats: tokenRows,
      payment_orders: [...usdOrders, otherCurrencyOrder],
    })).getFinanceStats();

    expect(result.financeOverview.paidRevenueCents).toBe(1001);
    expect(result.financeOverview.recordedCostUsd).toBeCloseTo(0.001001, 9);
    expect(result.financeOverview.creditsConsumed).toBe(1001);
  });

  it('derives runtime billing ranges from active model pricing instead of retired system token settings', async () => {
    const selectCalls: Array<{ table: string; columns?: string }> = [];

    const adminSupabase = {
      rpc: adminStatsRpc(),
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
                    model_id: 'openai/model-a',
                    provider: 'anthropic',
                    is_active: 'true',
                    config: (() => { const row = pricedModel(); row.config.pricing.model = row.config.reasoning.catalog.model = 'openai/model-a'; return row.config; })(),
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
                    model_id: 'openai/model-b',
                    provider: 'anthropic',
                    is_active: 'true',
                    config: (() => { const row = pricedModel(); row.config.pricing.model = row.config.reasoning.catalog.model = 'openai/model-b'; return row.config; })(),
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
            case 'token_stats':
              return { data: [], error: null };
            case 'payment_orders':
              return { data: [], error: null };
            case 'billing_history':
              return { data: [], error: null };
            case 'system_settings':
              return {
                data: [
                  { key: 'new_user_credits', value: '120' },
                  { key: 'search_surcharge_credits', value: '7' },
                  { key: 'input_credits_per_1k', value: '999' },
                  { key: 'billing_credits_per_usd', value: '1000' },
                  { key: 'billing_token_price_multiplier', value: '1.5' },
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
    const result = await caller.getFinanceStats();

    expect(result.modelStats[0]?.pricing).toMatchObject({ status: 'ready', base: { prompt: '2' },
      frozen: { promptUsdPerMillion: '3' } });
    expect(result.modelStats[0]).not.toHaveProperty('inputTokenCost');
    expect(result.runtimeBilling).toEqual({
      creditsPerUsd: 1000,
      tokenPriceMultiplier: 1.5,
      billingUnitSource: { creditsPerUsd: 'configured', defaultMultiplier: 'configured' },
      activeModelCount: 2,
      unknownModelActiveCount: 0,
      inputCreditsPer1KRange: { min: 4.5, max: 4.5 },
      outputCreditsPer1KRange: { min: 7.5, max: 7.5 },
      searchCreditsPer1KRange: null,
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
      auditRecorded: true,
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
      auditRecorded: true,
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
      auditRecorded: true,
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
      auditRecorded: true,
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
        if (table === 'payment_provider_refs') return {
          select() { return this; }, eq() { return this; }, in: async () => ({ data: [], error: null }),
        };
        adminQueries.push(table);

        const execute = async () => {
          if (table === 'credit_packages') {
            return {
              data: [{
                id: 'pkg-1',
                name: 'Starter',
                price: 999,
                credits_amount: 1000,
                bonus_credits: 100,
                stripe_price_id: null,
                sort_order: 1,
                is_popular: 'false',
                active: 'true',
                created_at: '2026-03-29T08:00:00.000Z',
              }],
              error: null,
            };
          }

          if (table === 'membership_plans') {
            return {
              data: [{
                id: 'plan-1',
                name: 'Pro',
                level: 'pro',
                monthly_price: 9900,
                yearly_price: 99900,
                stripe_monthly_price_id: null,
                stripe_yearly_price_id: null,
                monthly_credits: 1000,
                yearly_credits: 12000,
                monthly_bonus_credits: 100,
                package_discount: 90,
                features: ['Feature A'],
                max_context_messages: 20,
                is_active: 'true',
                sort_order: 1,
                created_at: '2026-03-29T08:00:00.000Z',
              }],
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
      packages: [{
        id: 'pkg-1',
        name: 'Starter',
        price: 999,
        credits_amount: 1000,
        bonus_credits: 100,
        stripe_price_id: null,
        sort_order: 1,
        is_popular: 'false',
        active: 'true',
        created_at: '2026-03-29T08:00:00.000Z',
      }],
      membershipPlans: [{
        id: 'plan-1',
        name: 'Pro',
        level: 'pro',
        monthly_price: 9900,
        yearly_price: 99900,
        stripe_monthly_price_id: null,
        stripe_yearly_price_id: null,
        monthly_credits: 1000,
        yearly_credits: 12000,
        monthly_bonus_credits: 100,
        package_discount: 90,
        features: ['Feature A'],
        max_context_messages: 20,
        is_active: 'true',
        sort_order: 1,
        created_at: '2026-03-29T08:00:00.000Z',
      }],
    });
    expect(adminQueries).toEqual(['credit_packages', 'membership_plans']);
  });

  it('aggregates settings bootstrap data with one settings query and one plans query', async () => {
    const adminQueries: string[] = [];

    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_provider_refs') return {
          select() { return this; }, eq() { return this; }, in: async () => ({ data: [], error: null }),
        };
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
              data: [{
                id: 'plan-1',
                stripe_monthly_price_id: null, stripe_yearly_price_id: null,
                name: 'Pro',
                level: 'pro',
                allow_export: 'true',
                allow_batch_export: 'false',
        allow_fusion_review: true,
        allow_fusion_compare: true,
        library_storage_bytes: 500_000_000,
        positioning_profile_limit: 3,
              }],
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
      membershipPlans: [{
        id: 'plan-1',
        stripe_monthly_price_id: null, stripe_yearly_price_id: null,
        name: 'Pro',
        level: 'pro',
        allow_export: 'true',
        allow_batch_export: 'false',
        allow_fusion_review: true,
        allow_fusion_compare: true,
        library_storage_bytes: 500_000_000,
        positioning_profile_limit: 3,
      }],
    });
    expect(adminQueries).toEqual(['system_settings', 'membership_plans']);
  });

  it.each(['999', null])('loads the settings dashboard after saving stop-loss alert %s', async (siteAlertUsd) => {
    const stopLoss = {
      version: 1, revision: 2, userDailyUsd: null, siteDailyUsd: null,
      siteAlertUsd, providerBalanceAlertUsd: null, notificationChannel: null,
    };
    const adminSupabase = {
      from(table: string) {
        return createAwaitableQueryBuilder(Promise.resolve({
          data: table === 'system_settings' ? [
            { key: 'site_name', value: 'Graylum AI' },
            { key: 'runtime_stop_loss', value: stopLoss },
          ] : [],
          error: null,
        }));
      },
    };

    await expect(createAdminCaller(adminSupabase).getSettingsDashboard()).resolves.toEqual({
      systemSettings: { site_name: 'Graylum AI' },
      membershipPlans: [],
    });
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

  it('accepts genuinely empty settings and packages dashboards', async () => {
    const adminSupabase = {
      from() {
        return createAwaitableQueryBuilder(Promise.resolve({ data: [], error: null }));
      },
    };
    const caller = createAdminCaller(adminSupabase);

    await expect(caller.getSettingsDashboard()).resolves.toEqual({
      systemSettings: {},
      membershipPlans: [],
    });
    await expect(caller.getPackagesDashboard()).resolves.toEqual({
      packages: [],
      membershipPlans: [],
    });
  });

  it.each([
    ['malformed setting row', 'system_settings', [{ key: 'site_name', value: null }]],
    ['malformed settings membership row', 'membership_plans', [{
      id: 'plan-1',
      name: 'Pro',
      level: 'pro',
      allow_export: 'maybe',
      allow_batch_export: 'false',
        allow_fusion_review: true,
        allow_fusion_compare: true,
        library_storage_bytes: 500_000_000,
    }]],
  ])('fails the settings dashboard for a %s', async (_caseName, invalidTable, invalidData) => {
    const adminSupabase = {
      from(table: string) {
        const validData = table === 'system_settings'
          ? [{ key: 'site_name', value: 'Graylum AI' }]
          : [{
              id: 'plan-1',
              name: 'Pro',
              level: 'pro',
              allow_export: 'true',
              allow_batch_export: 'false',
        allow_fusion_review: true,
        allow_fusion_compare: true,
        library_storage_bytes: 500_000_000,
            }];
        return createAwaitableQueryBuilder(Promise.resolve({
          data: table === invalidTable ? invalidData : validData,
          error: null,
        }));
      },
    };
    const caller = createAdminCaller(adminSupabase);

    await expect(caller.getSettingsDashboard()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取设置页数据失败，请稍后重试',
    });
  });

  it.each([
    ['malformed package row', 'credit_packages', [{
      id: 'pkg-1',
      name: 'Starter',
      price: '999',
      credits_amount: 1000,
      bonus_credits: 0,
      stripe_price_id: null,
      sort_order: 1,
      is_popular: 'false',
      active: 'true',
      created_at: '2026-03-29T08:00:00.000Z',
    }]],
    ['malformed package membership row', 'membership_plans', [{
      id: 'plan-1',
      name: 'Pro',
      level: 'pro',
      monthly_price: 9900,
      yearly_price: 99900,
      stripe_monthly_price_id: null,
      stripe_yearly_price_id: null,
      monthly_credits: 1000,
      yearly_credits: 12000,
      monthly_bonus_credits: 100,
      package_discount: 90,
      features: 'not-an-array',
      max_context_messages: 20,
      is_active: 'true',
      sort_order: 1,
      created_at: '2026-03-29T08:00:00.000Z',
    }]],
  ])('fails the packages dashboard for a %s', async (_caseName, invalidTable, invalidData) => {
    const validPackage = {
      id: 'pkg-1',
      name: 'Starter',
      price: 999,
      credits_amount: 1000,
      bonus_credits: 0,
      stripe_price_id: null,
      sort_order: 1,
      is_popular: 'false',
      active: 'true',
      created_at: '2026-03-29T08:00:00.000Z',
    };
    const validPlan = {
      id: 'plan-1',
      name: 'Pro',
      level: 'pro',
      monthly_price: 9900,
      yearly_price: 99900,
      stripe_monthly_price_id: null,
      stripe_yearly_price_id: null,
      monthly_credits: 1000,
      yearly_credits: 12000,
      monthly_bonus_credits: 100,
      package_discount: 90,
      features: ['Feature A'],
      max_context_messages: 20,
      is_active: 'true',
      sort_order: 1,
      created_at: '2026-03-29T08:00:00.000Z',
    };
    const adminSupabase = {
      from(table: string) {
        return createAwaitableQueryBuilder(Promise.resolve({
          data: table === invalidTable
            ? invalidData
            : table === 'credit_packages' ? [validPackage] : [validPlan],
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

  it.each([null, { code: '23503' }, { code: '42501' }])('deletes unused modules and reports failures: %j', async (error) => {
    const builder: any = { delete: () => builder, eq: () => builder, select: () => builder,
      maybeSingle: async () => ({ data: error ? null : { id: '00000000-0000-4000-8000-000000000003' }, error }) };
    const caller = createAdminCaller({ from: () => builder });
    const action = caller.removePrompt({ id: '00000000-0000-4000-8000-000000000003' });
    if (error?.code === '23503') await expect(action).rejects.toMatchObject({ code: 'CONFLICT' });
    else if (error) await expect(action).rejects.toThrow();
    else expect(await action).toMatchObject({ success: true, deletedId: '00000000-0000-4000-8000-000000000003' });
  });

  it.each([null, { code: '23503' }, { code: '42501' }])('deletes one atomic batch and reports failures: %j', async error => {
    const id = '00000000-0000-4000-8000-000000000003';
    const remove = vi.fn();
    const filter = vi.fn();
    const builder: any = {
      delete: () => { remove(); return builder; },
      in: (column: string, ids: string[]) => { filter(column, ids); return builder; },
      select: async () => ({ data: error ? null : [{ id }], error }),
    };
    const caller = createAdminCaller({ from: () => builder });
    const action = caller.removePrompts({ ids: [id, id] });
    if (error?.code === '23503') await expect(action).rejects.toMatchObject({ code: 'CONFLICT' });
    else if (error) await expect(action).rejects.toThrow();
    else expect(await action).toEqual({ success: true, deletedIds: [id] });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(filter).toHaveBeenCalledWith('id', [id]);
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
