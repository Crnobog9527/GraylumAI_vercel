import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsServiceState = vi.hoisted(() => ({
  runAllTests: vi.fn(),
  runCategoryTests: vi.fn(),
  getLatestResults: vi.fn(),
  getSummaryStats: vi.fn(),
}));

// ADMIN-SECRETS OR-1: the health check asks whether the platform OpenRouter Vault slot is filled in.
const platformKey = vi.hoisted(() => ({ state: 'configured' as 'configured' | 'missing' | 'unavailable' }));
vi.mock('../services/models/openRouterKey', () => ({
  openRouterKeyConfigured: async () => {
    if (platformKey.state === 'unavailable') throw new Error('PLATFORM_SECRET_UNAVAILABLE');
    return platformKey.state === 'configured';
  },
}));

vi.mock('../services/diagnostics', () => {
  class DiagnosticsService {
    runAllTests = diagnosticsServiceState.runAllTests;
    runCategoryTests = diagnosticsServiceState.runCategoryTests;
    getLatestResults = diagnosticsServiceState.getLatestResults;
    getSummaryStats = diagnosticsServiceState.getSummaryStats;
  }

  return {
    DiagnosticsService,
  };
});

import { diagnosticsRouter } from './diagnostics';

function createProfilesQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    limit() {
      return result;
    },
    single() {
      return result;
    },
  };
}

function createBatchResultsQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createRecentRunsQueryBuilder(result: Promise<unknown>) {
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
  };
}

function createHealthQueryBuilder(result: Promise<unknown>, admin = false) {
  return {
    select(columns: string) {
      if (!admin && columns === '*') throw new Error('42501');
      return this;
    },
    eq() {
      return this;
    },
    not() {
      return result;
    },
    limit() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

const cleanupCalls: Array<[string, unknown]> = [];

function createAdminCaller(options?: {
  role?: string;
  batchResult?: { data: unknown; error: unknown };
  recentRunsResult?: { data: unknown; error: unknown };
  cleanupResult?: { count: number | null; error: unknown };
  profilesResult?: { data: unknown; error: unknown };
  aiModelsResult?: { data: unknown; error: unknown };
}) {
  let profileCallCount = 0;
  const userScopedSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        profileCallCount += 1;
        const result = profileCallCount === 1
          ? {
              data: {
                id: 'admin-user',
                role: options?.role ?? 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }
          : (options?.profilesResult ?? { data: [{ id: 'admin-user' }], error: null });
        return createProfilesQueryBuilder(
          Promise.resolve(result),
        );
      }

      if (table === 'ai_models') {
        const result = options?.aiModelsResult ?? { data: [{ id: 'model-1' }], error: null };
        return createHealthQueryBuilder(Promise.resolve(result));
      }

      throw new Error(`Unexpected user-scoped table ${table}`);
    },
  };

  const adminSupabase = {
    from(table: string) {
      if (table === 'diagnostic_results') {
        // cleanupOldResults deletes directly; the 0005 cleanup RPC is absent on staging.
        const result = options?.cleanupResult ?? { count: 0, error: null };
        const deleteBuilder = {
          lt: (column: string, value: string) => {
            cleanupCalls.push([column, value]);
            return Promise.resolve(result);
          },
        };
        // Since 0146 diagnostic_results is service_role-only; reads also go through this client.
        const readBuilder = options?.batchResult
          ? createBatchResultsQueryBuilder(Promise.resolve(options.batchResult))
          : createRecentRunsQueryBuilder(Promise.resolve(options?.recentRunsResult ?? { data: [], error: null }));
        return { ...readBuilder, delete: (opts: unknown) => { cleanupCalls.push(['delete', opts]); return deleteBuilder; } };
      }
      throw new Error(`Unexpected admin-scoped table ${table}`);
    },
    rpc(fn: string) {
      throw new Error(`Unexpected rpc ${fn}`);
    },
  };

  return diagnosticsRouter.createCaller({
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

function createAdminHealthCaller(options?: {
  profilesResult?: { data: unknown; error: unknown };
  aiModelsResult?: { data: unknown; error: unknown };
}) {
  let profileCallCount = 0;
  const authSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        profileCallCount += 1;
        const result = profileCallCount === 1
          ? {
              data: {
                id: 'admin-user',
                role: 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }
          : (options?.profilesResult ?? { data: [{ id: 'admin-user' }], error: null });
        return createProfilesQueryBuilder(
          Promise.resolve(result),
        );
      }

      if (table === 'ai_models') {
        const result = options?.aiModelsResult ?? { data: [{ id: 'model-1' }], error: null };
        return createHealthQueryBuilder(Promise.resolve(result));
      }

      throw new Error(`Unexpected auth table ${table}`);
    },
  };

  const adminSupabase = {
    from(table: string) {
      throw new Error(`Unexpected admin table ${table}`);
    },
  };

  return diagnosticsRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: authSupabase,
    supabaseAuth: authSupabase,
    supabasePublic: {},
    supabaseAdmin: adminSupabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('diagnosticsRouter error sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a safe generic error when runAllTests crashes', async () => {
    diagnosticsServiceState.runAllTests.mockRejectedValueOnce(
      new Error('relation diagnostic_results does not exist'),
    );

    const caller = createAdminCaller();

    await expect(caller.runAllTests()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '诊断执行失败，请稍后重试',
    });
  });

  it('sanitizes database errors when loading batch results', async () => {
    const caller = createAdminCaller({
      batchResult: {
        data: null,
        error: { message: 'syntax error at or near select' },
      },
    });

    await expect(caller.getBatchResults({ batchId: 'batch-1' })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取诊断批次结果失败，请稍后重试',
    });
  });

  it('deletes results older than the retention window and reports the count', async () => {
    cleanupCalls.length = 0;
    const caller = createAdminCaller({ cleanupResult: { count: 7, error: null } });
    const before = Date.now();

    await expect(caller.cleanupOldResults({ daysToKeep: 30 })).resolves.toMatchObject({
      success: true, deletedCount: 7,
    });
    expect(cleanupCalls[0]).toEqual(['delete', { count: 'exact' }]);
    const cutoff = Date.parse(cleanupCalls[1][1] as string);
    expect(cleanupCalls[1][0]).toBe('created_at');
    expect(Math.abs(before - 30 * 24 * 60 * 60 * 1000 - cutoff)).toBeLessThan(5000);
  });

  it('sanitizes cleanup errors', async () => {
    const caller = createAdminCaller({
      cleanupResult: {
        count: null,
        error: { message: 'permission denied for table diagnostic_results', code: '42501' },
      },
    });

    await expect(caller.cleanupOldResults()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '清理诊断记录失败，请稍后重试',
    });
  });

  it('sanitizes health check database and model failures', async () => {
    const caller = createAdminHealthCaller({
      profilesResult: {
        data: null,
        error: { message: 'permission denied for table profiles' },
      },
      aiModelsResult: {
        data: null,
        error: { message: 'relation ai_models does not exist' },
      },
    });
    platformKey.state = 'unavailable';

    await expect(caller.healthCheck()).resolves.toMatchObject({
      checks: {
        database: {
          ok: false,
          message: '数据库连接异常，请检查服务端日志',
        },
        aiModels: {
          ok: false,
          message: '模型配置读取异常，请检查服务端日志',
        },
        apiKey: {
          ok: false,
          message: '暂时无法读取第三方密钥状态，请检查服务端日志',
        },
      },
    });
    platformKey.state = 'missing';
    await expect(createAdminHealthCaller().healthCheck()).resolves.toMatchObject({
      checks: { apiKey: { ok: false, message: 'OpenRouter 密钥未填写，请到后台“第三方密钥”页填写' } },
    });
    platformKey.state = 'configured';
  });

  it('aggregates diagnostics dashboard payload from one query', async () => {
    diagnosticsServiceState.getLatestResults.mockResolvedValueOnce([
      { testId: 'ai_model_status', status: 'passed', message: 'ok', category: 'ai', testName: 'AI', latencyMs: 12 },
    ]);
    diagnosticsServiceState.getSummaryStats.mockResolvedValueOnce({
      total_tests: 1,
      passed_tests: 1,
      failed_tests: 0,
      warning_tests: 0,
      pass_rate: 100,
      avg_latency_ms: 12,
      last_run: '2026-03-29T00:00:00.000Z',
    });
    const caller = createAdminCaller({
      recentRunsResult: {
        data: [
          { batch_id: 'batch-1', run_type: 'manual', created_at: '2026-03-29T10:00:00.000Z' },
          { batch_id: 'batch-1', run_type: 'manual', created_at: '2026-03-29T10:00:01.000Z' },
          { batch_id: 'batch-2', run_type: 'cron', created_at: '2026-03-28T10:00:00.000Z' },
        ],
        error: null,
      },
    });

    await expect(caller.getDashboard()).resolves.toMatchObject({
      latestResults: [
        expect.objectContaining({ testId: 'ai_model_status', status: 'passed' }),
      ],
      summaryStats: expect.objectContaining({ total_tests: 1, pass_rate: 100 }),
      healthCheck: expect.objectContaining({
        healthy: true,
        status: 'healthy',
      }),
      recentRuns: [
        expect.objectContaining({ batchId: 'batch-1', testCount: 2 }),
        expect.objectContaining({ batchId: 'batch-2', testCount: 1 }),
      ],
    });
  });
});

describe('diagnosticsRouter admin gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets an admin run all diagnostics, including the billing reconciliation', async () => {
    diagnosticsServiceState.runAllTests.mockResolvedValueOnce({ batchId: 'batch-1', results: [] });
    await expect(createAdminCaller().runAllTests()).resolves.toMatchObject({ batchId: 'batch-1' });
    expect(diagnosticsServiceState.runAllTests).toHaveBeenCalledTimes(1);
  });

  it('rejects a regular user before any diagnostic (and its service-role reads) runs', async () => {
    // Each caller resolves the profile once, so use a fresh one per request.
    const caller = () => createAdminCaller({ role: 'user' });
    await expect(caller().runAllTests()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().runCategoryTests({ category: 'billing', runType: 'manual' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().runSingleTest({ testId: 'billing_reconcile' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(diagnosticsServiceState.runAllTests).not.toHaveBeenCalled();
    expect(diagnosticsServiceState.runCategoryTests).not.toHaveBeenCalled();
  });
});
