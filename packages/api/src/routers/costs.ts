/**
 * AI Costs Router - AI 成本监控路由
 *
 * 提供 AI 成本追踪和监控的 tRPC 端点
 */

import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { createSafeInternalError } from '../lib/publicError';
import { readAllReportRows } from '../services/reportRows';

import {
  costMetricSchema, getCostWindow, buildCostOverviewFromRows, buildCostsDashboardFromRows,
  buildTopUsersFromRows, buildCostTrendFromRows, buildModelDistributionFromRows,
  buildCacheEfficiencyFromRows, type CostOverview, type CostsDashboard, type DailyCost,
  type ModelDistribution, type TopUser, type UsageLog, type TokenStat,
  type CacheEfficiencySummary, type CostRow, type DashboardRow, type TopUserAggregateRow,
  type TopUserProfile,
} from '../services/costReport';
export { buildCostOverviewFromRows, buildCostsDashboardFromRows, buildTopUsersFromRows } from '../services/costReport';

const timezoneSchema = z.string().refine((timezone) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true; }
  catch { return false; }
}, 'Invalid timezone').default('Asia/Shanghai');

async function requireReportRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const result = await readAllReportRows(page);
  if (result.error || !result.data) {
    throw createSafeInternalError(result.error ?? new Error('Invalid report rows'), '读取成本报表失败，请稍后重试');
  }
  return result.data;
}

// ============================================
// Router
// ============================================

export const costsRouter = router({
  getDashboard: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
      limit: z.number().min(1).max(50).default(10),
      timezone: timezoneSchema,
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<CostsDashboard> => {
      const now = new Date();
      const window = getCostWindow(now, input.days, input.timezone);
      const queryStartIso = window.rangeStartIso < window.monthStartIso
        ? window.rangeStartIso : window.monthStartIso;
      const rows = await requireReportRows<DashboardRow>((from, to) => ctx.supabase
        .from('token_stats')
        .select('user_id, model_used, total_credits, total_cost_usd, cached_tokens, input_tokens, created_at')
        .gte('created_at', queryStartIso)
        .order('created_at').order('id').range(from, to));
      const topUserIds = buildTopUsersFromRows(
        rows.filter((row) => row.created_at >= window.rangeStartIso),
        [],
        input.metric,
        input.limit,
      ).map((user) => user.userId);

      const { data: profileData, error: profileError } = topUserIds.length
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname')
            .in('id', topUserIds)
        : { data: [], error: null };
      if (profileError || !profileData) {
        throw createSafeInternalError(profileError ?? new Error('Invalid profiles'), '读取成本报表失败，请稍后重试');
      }

      return buildCostsDashboardFromRows(rows, (profileData ?? []) as TopUserProfile[], {
        metric: input.metric,
        days: input.days,
        limit: input.limit,
        now,
        timezone: input.timezone,
        ...window,
      });
    }),

  /**
   * 获取成本概览
   */
  getOverview: adminProcedure
    .input(z.object({
      timezone: timezoneSchema,
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<CostOverview> => {
      const now = new Date();
      const window = getCostWindow(now, 1, input.timezone);
      const monthData = await requireReportRows<CostRow>((from, to) => ctx.supabase
        .from('token_stats')
        .select('total_credits, total_cost_usd, created_at')
        .gte('created_at', window.monthStartIso)
        .order('created_at').order('id').range(from, to));

      return buildCostOverviewFromRows(
        monthData,
        window.todayStartIso,
        input.metric,
      );
    }),

  /**
   * 获取成本趋势
   */
  getCostTrend: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
      timezone: timezoneSchema,
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<DailyCost[]> => {
      const now = new Date();
      const { rangeStartIso } = getCostWindow(now, input.days, input.timezone);
      const rows = await requireReportRows<CostRow>((from, to) => ctx.supabase
        .from('token_stats')
        .select('total_credits, total_cost_usd, created_at')
        .gte('created_at', rangeStartIso)
        .order('created_at').order('id').range(from, to));
      return buildCostTrendFromRows(rows, input.days, input.metric, now, input.timezone);
    }),

  /**
   * 获取模型分布
   */
  getModelDistribution: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(30),
      timezone: timezoneSchema,
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<ModelDistribution[]> => {
      const { rangeStartIso } = getCostWindow(new Date(), input.days, input.timezone);
      const rows = await requireReportRows<Pick<DashboardRow,
        'model_used' | 'total_credits' | 'total_cost_usd'>>((from, to) => ctx.supabase
        .from('token_stats')
        .select('model_used, total_credits, total_cost_usd')
        .gte('created_at', rangeStartIso)
        .order('created_at').order('id').range(from, to));
      return buildModelDistributionFromRows(rows, input.metric);
    }),

  /**
   * 获取高消耗用户
   */
  getTopUsers: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(30),
      limit: z.number().min(1).max(50).default(10),
      timezone: timezoneSchema,
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<TopUser[]> => {
      const { rangeStartIso } = getCostWindow(new Date(), input.days, input.timezone);
      const rows = await requireReportRows<TopUserAggregateRow>((from, to) => ctx.supabase
        .from('token_stats')
        .select('user_id, total_credits, total_cost_usd')
        .gte('created_at', rangeStartIso)
        .order('created_at').order('id').range(from, to));

      const topUserIds = Array.from(
        new Set(
          buildTopUsersFromRows(
            rows,
            [],
            input.metric,
            input.limit,
          ).map((user) => user.userId),
        ),
      );

      const { data: profileData, error: profileError } = topUserIds.length
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname')
            .in('id', topUserIds)
        : { data: [], error: null };
      if (profileError || !profileData) {
        throw createSafeInternalError(profileError ?? new Error('Invalid profiles'), '读取成本报表失败，请稍后重试');
      }

      return buildTopUsersFromRows(
        rows,
        profileData as TopUserProfile[],
        input.metric,
        input.limit,
      );
    }),

  /**
   * 获取 AI 调用日志
   */
  getUsageLogs: adminProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(10).max(100).default(20),
      status: z.enum(['all', 'success', 'failed']).optional().default('all'),
    }))
    .query(async ({ ctx, input }): Promise<{ logs: UsageLog[]; total: number }> => {
      const offset = (input.page - 1) * input.pageSize;

      let query = ctx.supabase
        .from('ai_usage_logs')
        .select(`
          id,
          request_id,
          user_id,
          model_id,
          status,
          input_length,
          latency_ms,
          metadata,
          created_at,
          profiles (
            email
          )
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + input.pageSize - 1);

      if (input.status === 'success') query = query.eq('status', 'success');
      if (input.status === 'failed') query = query.neq('status', 'success');

      const { data, count, error } = await query;

      if (error) {
        logger.error('ai', 'costs_usage_logs_fetch_failed', {
          code: error.code,
        });
        throw createSafeInternalError(error, '读取 AI 调用日志失败，请稍后重试');
      }

      const logs: UsageLog[] = (data ?? []).map((record: any) => ({
        id: record.id,
        requestId: record.request_id ?? null,
        userId: record.user_id,
        userEmail: record.profiles?.email ?? 'unknown',
        modelId: record.model_id,
        status: record.status,
        inputLength: record.input_length ?? 0,
        latencyMs: record.latency_ms ?? 0,
        routingReason: record.metadata?.routingReason ?? null,
        promptName: record.metadata?.promptName ?? null,
        createdAt: record.created_at,
      }));

      return { logs, total: count ?? 0 };
    }),

  /**
   * 获取 Token 统计
   */
  getTokenStats: adminProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(10).max(100).default(20),
    }))
    .query(async ({ ctx, input }): Promise<{ stats: TokenStat[]; total: number }> => {
      const offset = (input.page - 1) * input.pageSize;

      const { data, count, error } = await ctx.supabase
        .from('token_stats')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + input.pageSize - 1);

      if (error) {
        logger.error('billing', 'costs_token_stats_fetch_failed', {
          code: error.code,
        });
        throw createSafeInternalError(error, '读取 Token 统计失败，请稍后重试');
      }

      const stats: TokenStat[] = (data ?? []).map((record: any) => ({
        id: record.id,
        conversationId: record.conversation_id,
        modelUsed: record.model_used ?? 'unknown',
        inputTokens: record.input_tokens ?? 0,
        outputTokens: record.output_tokens ?? 0,
        cachedTokens: record.cached_tokens ?? 0,
        totalCredits: record.total_credits ?? 0,
        createdAt: record.created_at,
      }));

      return { stats, total: count ?? 0 };
    }),

  /**
   * 获取缓存效率
   */
  getCacheEfficiency: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
      timezone: timezoneSchema,
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<CacheEfficiencySummary> => {
      const { rangeStartIso } = getCostWindow(new Date(), input.days, input.timezone);
      const rows = await requireReportRows<Pick<DashboardRow,
        'cached_tokens' | 'input_tokens' | 'total_credits' | 'total_cost_usd'>>((from, to) => ctx.supabase
        .from('token_stats')
        .select('cached_tokens, input_tokens, total_credits, total_cost_usd')
        .gte('created_at', rangeStartIso)
        .order('created_at').order('id').range(from, to));
      return buildCacheEfficiencyFromRows(rows, input.metric);
    }),
});
