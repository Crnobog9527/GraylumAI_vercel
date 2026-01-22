/**
 * Diagnostics Router
 *
 * 系统诊断 tRPC 路由
 * 提供系统健康检查和诊断测试功能
 */

import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { DiagnosticsService, type DiagnosticCategory } from '../services/diagnostics';

export const diagnosticsRouter = router({
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
        userId: ctx.profileId,
        runType: input?.runType ?? 'manual',
      });

      try {
        const result = await service.runAllTests();
        return result;
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `诊断测试失败: ${error instanceof Error ? error.message : String(error)}`,
        });
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
        userId: ctx.profileId,
        runType: input.runType,
      });

      try {
        const result = await service.runCategoryTests(input.category as DiagnosticCategory);
        return result;
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `诊断测试失败: ${error instanceof Error ? error.message : String(error)}`,
        });
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
        userId: ctx.profileId,
      });

      try {
        const results = await service.getLatestResults();
        return results;
      } catch (error) {
        console.error('Failed to get latest results:', error);
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
        userId: ctx.profileId,
      });

      try {
        const history = await service.getTestHistory(input.testId, input.limit);
        return history;
      } catch (error) {
        console.error('Failed to get test history:', error);
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
        userId: ctx.profileId,
      });

      try {
        const stats = await service.getSummaryStats(input?.hours ?? 24);
        return stats;
      } catch (error) {
        console.error('Failed to get summary stats:', error);
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
    }),

  /**
   * 获取最近的诊断运行记录
   */
  getRecentRuns: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(20).default(5),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 5;

      const { data, error } = await ctx.supabase
        .from('diagnostic_results')
        .select('batch_id, run_type, created_at')
        .order('created_at', { ascending: false })
        .limit(limit * 11); // 每个 batch 最多 11 条

      if (error) {
        console.error('Failed to get recent runs:', error);
        return [];
      }

      // 按 batch_id 分组
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
    }),

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
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error.message,
        });
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

      const { data, error } = await ctx.supabase.rpc('cleanup_old_diagnostic_results', {
        p_days_to_keep: daysToKeep,
      });

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `清理失败: ${error.message}`,
        });
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
    .query(async ({ ctx }) => {
      const checks: Record<string, { ok: boolean; message: string }> = {};

      // 检查数据库连接
      try {
        const { error } = await ctx.supabase.from('profiles').select('id').limit(1);
        checks.database = { ok: !error, message: error?.message ?? 'OK' };
      } catch (e) {
        checks.database = { ok: false, message: String(e) };
      }

      // 检查 AI 模型配置
      try {
        const { data, error } = await ctx.supabase
          .from('ai_models')
          .select('id')
          .eq('is_active', 'true')
          .limit(1);
        checks.aiModels = {
          ok: !error && (data?.length ?? 0) > 0,
          message: error?.message ?? (data?.length ? 'OK' : '没有启用的 AI 模型'),
        };
      } catch (e) {
        checks.aiModels = { ok: false, message: String(e) };
      }

      // 检查 API Key (同时检查环境变量和数据库配置)
      const hasEnvApiKey = !!process.env.ANTHROPIC_API_KEY;
      let hasDbApiKey = false;
      try {
        const { data: modelsWithKey } = await ctx.supabase
          .from('ai_models')
          .select('api_key')
          .eq('is_active', 'true')
          .not('api_key', 'is', null);
        hasDbApiKey = (modelsWithKey?.length ?? 0) > 0 &&
          modelsWithKey!.some(m => m.api_key && m.api_key.length > 0);
      } catch {
        // 忽略数据库查询错误
      }

      const hasApiKey = hasEnvApiKey || hasDbApiKey;
      checks.apiKey = {
        ok: hasApiKey,
        message: hasApiKey
          ? `OK (${hasEnvApiKey ? '环境变量' : ''}${hasEnvApiKey && hasDbApiKey ? '+' : ''}${hasDbApiKey ? '数据库' : ''})`
          : 'API 密钥未配置 (环境变量 ANTHROPIC_API_KEY 或数据库 ai_models.api_key)',
      };

      // 计算总体健康状态
      const allOk = Object.values(checks).every((c) => c.ok);
      const failedCount = Object.values(checks).filter((c) => !c.ok).length;

      return {
        healthy: allOk,
        status: allOk ? 'healthy' : failedCount > 1 ? 'critical' : 'warning',
        checks,
        timestamp: new Date().toISOString(),
      };
    }),
});

export default diagnosticsRouter;
