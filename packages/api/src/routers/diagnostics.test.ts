import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsServiceState = vi.hoisted(() => ({
  runAllTests: vi.fn(),
  runCategoryTests: vi.fn(),
  getLatestResults: vi.fn(),
  getSummaryStats: vi.fn(),
  getLatestRuntimeProof: vi.fn(),
}));

vi.mock('../services/diagnostics', () => {
  class DiagnosticsService {
    runAllTests = diagnosticsServiceState.runAllTests;
    runCategoryTests = diagnosticsServiceState.runCategoryTests;
    getLatestResults = diagnosticsServiceState.getLatestResults;
    getSummaryStats = diagnosticsServiceState.getSummaryStats;
    getLatestRuntimeProof = diagnosticsServiceState.getLatestRuntimeProof;
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

function createHealthQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
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

function createAdminCaller(options?: {
  batchResult?: { data: unknown; error: unknown };
  recentRunsResult?: { data: unknown; error: unknown };
  cleanupResult?: { data: unknown; error: unknown };
  profilesResult?: { data: unknown; error: unknown };
  aiModelsResult?: { data: unknown; error: unknown };
  aiModelsKeyResult?: { data: unknown; error: unknown };
}) {
  const userScopedSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createProfilesQueryBuilder(
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

  let aiModelsCallCount = 0;
  const adminSupabase = {
    from(table: string) {
      if (table === 'diagnostic_results') {
        return options?.batchResult
          ? createBatchResultsQueryBuilder(Promise.resolve(options.batchResult))
          : createRecentRunsQueryBuilder(Promise.resolve(options?.recentRunsResult ?? { data: [], error: null }));
      }

      if (table === 'profiles') {
        return createHealthQueryBuilder(Promise.resolve(options?.profilesResult ?? {
          data: [{ id: 'admin-user' }],
          error: null,
        }));
      }

      if (table === 'ai_models') {
        aiModelsCallCount += 1;
        const result = aiModelsCallCount === 1
          ? (options?.aiModelsResult ?? { data: [{ id: 'model-1' }], error: null })
          : (options?.aiModelsKeyResult ?? { data: [{ api_key: 'secret' }], error: null });
        return createHealthQueryBuilder(Promise.resolve(result));
      }

      throw new Error(`Unexpected admin-scoped table ${table}`);
    },
    rpc(fn: string) {
      if (fn === 'cleanup_old_diagnostic_results') {
        return Promise.resolve(options?.cleanupResult ?? { data: 0, error: null });
      }

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
  aiModelsKeyResult?: { data: unknown; error: unknown };
}) {
  const authSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createProfilesQueryBuilder(
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

      throw new Error(`Unexpected auth table ${table}`);
    },
  };

  let aiModelsCallCount = 0;
  const adminSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createHealthQueryBuilder(Promise.resolve(options?.profilesResult ?? {
          data: [{ id: 'admin-user' }],
          error: null,
        }));
      }

      if (table === 'ai_models') {
        aiModelsCallCount += 1;
        const result = aiModelsCallCount === 1
          ? (options?.aiModelsResult ?? { data: [{ id: 'model-1' }], error: null })
          : (options?.aiModelsKeyResult ?? { data: [{ api_key: 'secret' }], error: null });
        return createHealthQueryBuilder(Promise.resolve(result));
      }

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

  it('returns a safe runtime proof fallback when lookup fails', async () => {
    diagnosticsServiceState.getLatestRuntimeProof.mockRejectedValueOnce(
      new Error('permission denied for table billing_audit_log'),
    );

    const caller = createAdminCaller();

    await expect(caller.getLatestRuntimeProof()).resolves.toMatchObject({
      found: false,
      status: 'error',
      message: '加载运行时凭证失败，请稍后重试',
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

  it('sanitizes cleanup rpc errors', async () => {
    const caller = createAdminCaller({
      cleanupResult: {
        data: null,
        error: { message: 'cleanup_old_diagnostic_results failed: permission denied' },
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
      aiModelsKeyResult: {
        data: null,
        error: { message: 'relation ai_models does not exist' },
      },
    });

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
          message: 'API 密钥未配置，请检查服务配置',
        },
      },
    });
  });

  it('aggregates diagnostics dashboard payload from one query', async () => {
    diagnosticsServiceState.getLatestResults.mockResolvedValueOnce([
      { testId: 'ai_routing', status: 'passed', message: 'ok', category: 'ai', testName: 'AI', latencyMs: 12 },
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
    diagnosticsServiceState.getLatestRuntimeProof.mockResolvedValueOnce({
      found: true,
      status: 'passed',
      message: 'runtime ok',
      checkedAt: '2026-03-29T00:00:00.000Z',
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
        expect.objectContaining({ testId: 'ai_routing', status: 'passed' }),
      ],
      summaryStats: expect.objectContaining({ total_tests: 1, pass_rate: 100 }),
      runtimeProof: expect.objectContaining({ found: true, status: 'passed' }),
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
