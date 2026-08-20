/**
 * Diagnostics Router
 *
 * 系统诊断 tRPC 路由
 * 提供系统健康检查和诊断测试功能
 */

import { router, adminProcedure } from '../trpc';
import { getConfiguredProviderApiKeySource } from '../services/providerUtils';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { DiagnosticsService, type DiagnosticCategory } from '../services/diagnostics';
import { createSafeInternalError } from '../lib/publicError';
import { logger } from '../lib/logger';

const DIAGNOSTICS_RUN_FAILURE_MESSAGE = '诊断执行失败，请稍后重试';
const DIAGNOSTICS_RUNTIME_PROOF_FAILURE_MESSAGE = '加载运行时凭证失败，请稍后重试';
const DIAGNOSTICS_BATCH_RESULTS_FAILURE_MESSAGE = '读取诊断批次结果失败，请稍后重试';
const DIAGNOSTICS_CLEANUP_FAILURE_MESSAGE = '清理诊断记录失败，请稍后重试';

function logDiagnosticsFallback(message: string, context: Record<string, unknown> = {}) {
  logger.warn('system', message, context);
}

function createSummaryStatsFallback() {
  return {
    total_tests: 0,
    passed_tests: 0,
    failed_tests: 0,
    warning_tests: 0,
    pass_rate: 0,
    avg_latency_ms: 0,
    last_run: null,
  };
}

function createRuntimeProofFallback(hours: number) {
  return {
    found: false,
    status: 'error' as const,
    message: DIAGNOSTICS_RUNTIME_PROOF_FAILURE_MESSAGE,
    checkedAt: new Date().toISOString(),
    hours,
  };
}

async function getRecentRunsData(
  supabase: any,
  limit: number,
): Promise<Array<{ batchId: string; runType: string; createdAt: string; testCount: number }>> {
  const { data, error } = await supabase
    .from('diagnostic_results')
    .select('batch_id, run_type, created_at')
    .order('created_at', { ascending: false })
    .limit(limit * 16);

  if (error) {
    logDiagnosticsFallback('diagnostics_recent_runs_failed', { limit, code: error.code ?? null });
    return [];
  }

  const batches = new Map<string, { batchId: string; runType: string; createdAt: string; testCount: number }>();

  for (const row of data ?? []) {
    if (!row.batch_id) continue;

    if (!batches.has(row.batch_id)) {
      batches.set(row.batch_id, {
        batchId: row.batch_id,
        runType: row.run_type,
        createdAt: row.created_at,
        testCount: 1,
      });
    } else {
      const batch = batches.get(row.batch_id)!;
      batch.testCount += 1;
    }
  }

  return Array.from(batches.values()).slice(0, limit);
}

async function getDiagnosticsHealthCheck(supabase: any) {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  try {
    const { error } = await supabase.from('profiles').select('id').limit(1);
    checks.database = {
      ok: !error,
      message: error ? '数据库连接异常，请检查服务端日志' : 'OK',
    };
  } catch {
    checks.database = { ok: false, message: '数据库连接异常，请检查服务端日志' };
  }

  try {
    const { data, error } = await supabase
      .from('ai_models')
      .select('id')
      .eq('is_active', 'true')
      .limit(1);
    checks.aiModels = {
      ok: !error && (data?.length ?? 0) > 0,
      message: error
        ? '模型配置读取异常，请检查服务端日志'
        : (data?.length ? 'OK' : '没有启用的 AI 模型'),
    };
  } catch {
    checks.aiModels = { ok: false, message: '模型配置读取异常，请检查服务端日志' };
  }

  const configuredKeySource = getConfiguredProviderApiKeySource();
  const hasEnvApiKey = Boolean(configuredKeySource?.startsWith('env:'));
  let hasDbApiKey = false;
  try {
    const { data: modelsWithKey } = await supabase
      .from('ai_models')
      .select('api_key')
      .eq('is_active', 'true')
      .not('api_key', 'is', null);
    hasDbApiKey = (modelsWithKey?.length ?? 0) > 0 &&
      modelsWithKey!.some((model: { api_key?: string | null }) => Boolean(model.api_key && model.api_key.length > 0));
  } catch {
    // ignore database lookup failures and rely on env result
  }

  const hasApiKey = hasEnvApiKey || hasDbApiKey;
  checks.apiKey = {
    ok: hasApiKey,
    message: hasApiKey
      ? 'OK (已配置)'
      : 'API 密钥未配置，请检查服务配置',
  };

  const allOk = Object.values(checks).every((check) => check.ok);
  const failedCount = Object.values(checks).filter((check) => !check.ok).length;

  return {
    healthy: allOk,
    status: allOk ? 'healthy' : failedCount > 1 ? 'critical' : 'warning',
    checks,
    timestamp: new Date().toISOString(),
  };
}

export const diagnosticsRouter = router({
  getDashboard: adminProcedure
    .input(z.object({
      summaryHours: z.number().min(1).max(168).default(24),
      runtimeHours: z.number().min(1).max(168).default(72),
      recentRunsLimit: z.number().min(1).max(20).default(5),
    }).optional())
    .query(async ({ ctx, input }) => {
      const summaryHours = input?.summaryHours ?? 24;
      const runtimeHours = input?.runtimeHours ?? 72;
      const recentRunsLimit = input?.recentRunsLimit ?? 5;

      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      const [latestResults, summaryStats, healthCheck, runtimeProof, recentRuns] = await Promise.all([
        service.getLatestResults().catch(() => {
          logDiagnosticsFallback('diagnostics_latest_results_failed');
          return [];
        }),
        service.getSummaryStats(summaryHours).catch(() => {
          logDiagnosticsFallback('diagnostics_summary_stats_failed', { hours: summaryHours });
          return createSummaryStatsFallback();
        }),
        getDiagnosticsHealthCheck(ctx.supabase),
        service.getLatestRuntimeProof(runtimeHours).catch(() => {
          logDiagnosticsFallback('diagnostics_runtime_proof_failed', { hours: runtimeHours });
          return createRuntimeProofFallback(runtimeHours);
        }),
        getRecentRunsData(ctx.supabase, recentRunsLimit),
      ]);

      return {
        latestResults,
        summaryStats,
        healthCheck,
        runtimeProof,
        recentRuns,
      };
    }),

  /**
   * 运行所有诊断测试
   */
  runAllTests: adminProcedure
    .input(z.object({
      runType: z.enum(['manual', 'cron', 'ci']).default('manual'),
    }).optional())
    .mutation(async ({ ctx, input }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
        runType: input?.runType ?? 'manual',
      });

      try {
        const result = await service.runAllTests();
        return result;
      } catch (error) {
        throw createSafeInternalError(error, DIAGNOSTICS_RUN_FAILURE_MESSAGE);
      }
    }),

  /**
   * 运行指定类别的测试
   */
  runCategoryTests: adminProcedure
    .input(z.object({
      category: z.enum(['ai', 'billing', 'security', 'performance', 'data']),
      runType: z.enum(['manual', 'cron', 'ci']).default('manual'),
    }))
    .mutation(async ({ ctx, input }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
        runType: input.runType,
      });

      try {
        const result = await service.runCategoryTests(input.category as DiagnosticCategory);
        return result;
      } catch (error) {
        throw createSafeInternalError(error, DIAGNOSTICS_RUN_FAILURE_MESSAGE);
      }
    }),

  /**
   * 运行单个测试
   */
  runSingleTest: adminProcedure
    .input(z.object({
      testId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
        runType: 'manual',
      });

      const result = await service.runSingleTest(input.testId);

      if (!result) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `测试 ${input.testId} 不存在`,
        });
      }

      return result;
    }),

  /**
   * 获取测试定义列表
   */
  getTestDefinitions: adminProcedure
    .query(async ({ ctx }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      return service.getTestDefinitions();
    }),

  /**
   * 获取最新测试结果
   */
  getLatestResults: adminProcedure
    .query(async ({ ctx }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      try {
        const results = await service.getLatestResults();
        return results;
      } catch (error) {
        logDiagnosticsFallback('diagnostics_latest_results_failed');
        return [];
      }
    }),

  /**
   * 获取测试历史
   */
  getTestHistory: adminProcedure
    .input(z.object({
      testId: z.string(),
      limit: z.number().min(1).max(100).default(10),
    }))
    .query(async ({ ctx, input }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      try {
        const history = await service.getTestHistory(input.testId, input.limit);
        return history;
      } catch (error) {
        logDiagnosticsFallback('diagnostics_test_history_failed', { limit: input.limit });
        return [];
      }
    }),

  /**
   * 获取诊断摘要统计
   */
  getSummaryStats: adminProcedure
    .input(z.object({
      hours: z.number().min(1).max(168).default(24), // 最多 7 天
    }).optional())
    .query(async ({ ctx, input }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      try {
        const stats = await service.getSummaryStats(input?.hours ?? 24);
        return stats;
      } catch (error) {
        logDiagnosticsFallback('diagnostics_summary_stats_failed', { hours: input?.hours ?? 24 });
        return createSummaryStatsFallback();
      }
    }),

  getLatestRuntimeProof: adminProcedure
    .input(z.object({
      hours: z.number().min(1).max(168).default(72),
    }).optional())
    .query(async ({ ctx, input }) => {
      const service = new DiagnosticsService({
        supabase: ctx.supabase,
        supabaseAdmin: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      try {
        return await service.getLatestRuntimeProof(input?.hours ?? 72);
      } catch (error) {
        logDiagnosticsFallback('diagnostics_runtime_proof_failed', { hours: input?.hours ?? 72 });
        return createRuntimeProofFallback(input?.hours ?? 72);
      }
    }),

  /**
   * 获取最近的诊断运行记录
   */
  getRecentRuns: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(20).default(5),
    }).optional())
    .query(async ({ ctx, input }) => getRecentRunsData(ctx.supabase, input?.limit ?? 5)),

  /**
   * 获取指定批次的结果
   */
  getBatchResults: adminProcedure
    .input(z.object({
      batchId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('diagnostic_results')
        .select('*')
        .eq('batch_id', input.batchId)
        .order('created_at', { ascending: true });

      if (error) {
        throw createSafeInternalError(error, DIAGNOSTICS_BATCH_RESULTS_FAILURE_MESSAGE);
      }

      return (data ?? []).map((row) => ({
        testId: row.test_id,
        testName: row.test_name,
        category: row.category,
        status: row.status,
        message: row.message ?? '',
        details: row.details,
        latencyMs: row.latency_ms ?? 0,
        createdAt: row.created_at,
      }));
    }),

  /**
   * 清理旧的诊断记录
   */
  cleanupOldResults: adminProcedure
    .input(z.object({
      daysToKeep: z.number().min(1).max(90).default(30),
    }).optional())
    .mutation(async ({ ctx, input }) => {
      const daysToKeep = input?.daysToKeep ?? 30;

      const { data, error } = await ctx.supabaseAdmin.rpc('cleanup_old_diagnostic_results', {
        p_days_to_keep: daysToKeep,
      });

      if (error) {
        throw createSafeInternalError(error, DIAGNOSTICS_CLEANUP_FAILURE_MESSAGE);
      }

      return {
        success: true,
        deletedCount: data ?? 0,
        message: `已清理 ${daysToKeep} 天前的诊断记录`,
      };
    }),

  /**
   * 系统健康检查 (快速)
   * 不运行完整测试，只检查关键状态
   */
  healthCheck: adminProcedure
    .query(async ({ ctx }) => getDiagnosticsHealthCheck(ctx.supabase)),
});

export default diagnosticsRouter;
