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

function createAdminCaller(adminSupabase: Record<string, unknown>) {
  const userScopedSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createSingleQueryBuilder(
          Promise.resolve({
            data: {
              id: 'admin-user',
              role: 'admin',
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
      cleanupStats: {
        stats: [
          { level: 'free', retentionDays: 7, expiredCount: 2 },
          { level: 'pro', retentionDays: 30, expiredCount: 1 },
        ],
        totalExpired: 3,
        latestRun: {
          id: 'run-1',
          status: 'success',
          started_at: '2026-03-29T10:00:00.000Z',
          summary: { deletedCount: 3 },
          error: null,
        },
      },
    });
    expect(adminQueries).toEqual(['system_settings', 'membership_plans']);
    expect(cleanupState.getCleanupStats).toHaveBeenCalledOnce();
    expect(cleanupState.getLatestScheduledJobRun).toHaveBeenCalledOnce();
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

  it('aggregates prompts page bootstrap data in one endpoint', async () => {
    const adminQueries: string[] = [];

    const adminSupabase = {
      from(table: string) {
        adminQueries.push(table);

        const execute = async () => {
          if (table === 'prompts') {
            return {
              data: [{ id: 'prompt-1', active: 'true', category: 'general', is_system: 'false' }],
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
      prompts: [{ id: 'prompt-1', active: 'true', category: 'general', is_system: 'false' }],
      total: 1,
      hasMore: false,
      models: [{ id: 'model-1', name: 'Model 1' }],
      stats: {
        total: 1,
        active: 1,
        inactive: 0,
        system: 0,
      },
    });
    expect(adminQueries).toEqual(['prompts', 'prompts', 'ai_models']);
  });
});
