/**
 * AI Costs Router - AI 成本监控路由
 *
 * 提供 AI 成本追踪和监控的 tRPC 端点
 */

import { router, protectedProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { logger } from '../lib/logger';

const costMetricSchema = z.enum(['credits', 'usd']);
type CostMetric = z.infer<typeof costMetricSchema>;

// ============================================
// 类型定义
// ============================================

export interface CostOverview {
  metric: CostMetric;
  todayCost: number;
  todayCalls: number;
  monthCost: number;
  monthCalls: number;
  avgCostPerCall: number;
  todayCredits: number;
  todayUsd: number;
  monthCredits: number;
  monthUsd: number;
}

export interface ModelDistribution {
  modelId: string;
  modelName: string;
  calls: number;
  cost: number;
  percentage: number;
  credits: number;
  usd: number;
}

export interface DailyCost {
  date: string;
  cost: number;
  calls: number;
  credits: number;
  usd: number;
}

export interface TopUser {
  userId: string;
  email: string;
  nickname: string;
  totalCost: number;
  totalCalls: number;
  totalCredits: number;
  totalUsd: number;
}

export interface UsageLog {
  id: string;
  requestId: string | null;
  userId: string;
  userEmail: string;
  modelId: string;
  status: string;
  inputLength: number;
  latencyMs: number;
  routingReason: string | null;
  promptName: string | null;
  createdAt: string;
}

export interface TokenStat {
  id: string;
  conversationId: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalCredits: number;
  createdAt: string;
}

export interface CacheEfficiencySummary {
  totalRequests: number;
  cacheHits: number;
  hitRate: number;
  savedCredits: number;
  savedUsd: number;
  savedValue: number;
}

export interface CostsDashboard {
  overview: CostOverview;
  trend: DailyCost[];
  distribution: ModelDistribution[];
  topUsers: TopUser[];
  cacheEfficiency: CacheEfficiencySummary;
}

interface CostRow {
  total_credits: number | null;
  total_cost_usd: string | null;
  created_at: string;
}

interface DashboardRow extends CostRow {
  model_used: string | null;
  user_id: string | null;
  cached_tokens: number | null;
  input_tokens: number | null;
}

interface TopUserAggregateRow {
  user_id: string | null;
  total_credits: number | null;
  total_cost_usd: string | null;
}

interface TopUserProfile {
  id: string;
  email: string | null;
  nickname: string | null;
}

function parseUsd(value: string | null | undefined): number {
  return Number.parseFloat(value ?? '0') || 0;
}

export function buildCostOverviewFromRows(
  rows: CostRow[],
  todayStartIso: string,
  metric: CostMetric,
): CostOverview {
  let todayCredits = 0;
  let todayUsd = 0;
  let todayCalls = 0;
  let monthCredits = 0;
  let monthUsd = 0;

  for (const row of rows) {
    const credits = row.total_credits ?? 0;
    const usd = parseUsd(row.total_cost_usd);
    monthCredits += credits;
    monthUsd += usd;

    if (row.created_at >= todayStartIso) {
      todayCredits += credits;
      todayUsd += usd;
      todayCalls += 1;
    }
  }

  const monthCalls = rows.length;
  const todayCost = metric === 'usd' ? todayUsd : todayCredits;
  const monthCost = metric === 'usd' ? monthUsd : monthCredits;

  return {
    metric,
    todayCost,
    todayCalls,
    monthCost,
    monthCalls,
    avgCostPerCall: monthCalls > 0 ? Math.round(monthCost / monthCalls) : 0,
    todayCredits,
    todayUsd,
    monthCredits,
    monthUsd,
  };
}

export function buildTopUsersFromRows(
  rows: TopUserAggregateRow[],
  profiles: TopUserProfile[],
  metric: CostMetric,
  limit: number,
): TopUser[] {
  const aggregates = new Map<string, Omit<TopUser, 'email' | 'nickname' | 'userId'> & { email?: string; nickname?: string }>();

  for (const row of rows) {
    if (!row.user_id) {
      continue;
    }

    const existing = aggregates.get(row.user_id) ?? {
      totalCost: 0,
      totalCalls: 0,
      totalCredits: 0,
      totalUsd: 0,
    };
    const totalCredits = existing.totalCredits + (row.total_credits ?? 0);
    const totalUsd = existing.totalUsd + parseUsd(row.total_cost_usd);

    aggregates.set(row.user_id, {
      totalCalls: existing.totalCalls + 1,
      totalCredits,
      totalUsd,
      totalCost: metric === 'usd' ? totalUsd : totalCredits,
    });
  }

  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  return Array.from(aggregates.entries())
    .map(([userId, aggregate]) => ({
      userId,
      email: profileMap.get(userId)?.email ?? '',
      nickname: profileMap.get(userId)?.nickname ?? '',
      totalCost: aggregate.totalCost,
      totalCalls: aggregate.totalCalls,
      totalCredits: aggregate.totalCredits,
      totalUsd: aggregate.totalUsd,
    }))
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, limit);
}

export function buildCostTrendFromRows(
  rows: CostRow[],
  days: number,
  metric: CostMetric,
  now: Date,
): DailyCost[] {
  const dailyMap = new Map<string, { credits: number; usd: number; calls: number }>();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    dailyMap.set(dateStr!, { credits: 0, usd: 0, calls: 0 });
  }

  for (const record of rows) {
    const dateStr = new Date(record.created_at).toISOString().split('T')[0];
    const existing = dailyMap.get(dateStr!) ?? { credits: 0, usd: 0, calls: 0 };
    dailyMap.set(dateStr!, {
      credits: existing.credits + (record.total_credits ?? 0),
      usd: existing.usd + parseUsd(record.total_cost_usd),
      calls: existing.calls + 1,
    });
  }

  return Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      calls: data.calls,
      credits: data.credits,
      usd: data.usd,
      cost: metric === 'usd' ? data.usd : data.credits,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildModelDistributionFromRows(
  rows: Pick<DashboardRow, 'model_used' | 'total_credits' | 'total_cost_usd'>[],
  metric: CostMetric,
): ModelDistribution[] {
  const modelMap = new Map<string, { calls: number; credits: number; usd: number }>();
  let totalCost = 0;

  for (const record of rows) {
    const modelId = record.model_used ?? 'unknown';
    const existing = modelMap.get(modelId) ?? { calls: 0, credits: 0, usd: 0 };
    const credits = record.total_credits ?? 0;
    const usd = parseUsd(record.total_cost_usd);
    modelMap.set(modelId, {
      calls: existing.calls + 1,
      credits: existing.credits + credits,
      usd: existing.usd + usd,
    });
    totalCost += metric === 'usd' ? usd : credits;
  }

  return Array.from(modelMap.entries())
    .map(([modelId, data]) => ({
      modelId,
      modelName: getModelDisplayName(modelId),
      calls: data.calls,
      cost: metric === 'usd' ? data.usd : data.credits,
      credits: data.credits,
      usd: data.usd,
      percentage: totalCost > 0
        ? Math.round((((metric === 'usd' ? data.usd : data.credits) / totalCost) * 100))
        : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function buildCacheEfficiencyFromRows(
  rows: Pick<DashboardRow, 'cached_tokens' | 'input_tokens' | 'total_credits' | 'total_cost_usd'>[],
  metric: CostMetric,
): CacheEfficiencySummary {
  const totalRequests = rows.length;
  let cacheHits = 0;
  let totalCachedTokens = 0;
  let totalInputTokens = 0;
  let totalCredits = 0;
  let totalUsd = 0;

  for (const record of rows) {
    const cachedTokens = record.cached_tokens ?? 0;
    const inputTokens = record.input_tokens ?? 0;
    if (cachedTokens > 0) {
      cacheHits += 1;
    }
    totalCachedTokens += cachedTokens;
    totalInputTokens += inputTokens;
    totalCredits += record.total_credits ?? 0;
    totalUsd += parseUsd(record.total_cost_usd);
  }

  const savedCredits = totalInputTokens > 0
    ? Math.round((totalCachedTokens / totalInputTokens) * 0.9 * totalCredits)
    : 0;
  const savedUsd = totalInputTokens > 0
    ? (totalCachedTokens / totalInputTokens) * 0.9 * totalUsd
    : 0;

  return {
    totalRequests,
    cacheHits,
    hitRate: totalRequests > 0 ? Math.round((cacheHits / totalRequests) * 100) : 0,
    savedCredits,
    savedUsd,
    savedValue: metric === 'usd' ? savedUsd : savedCredits,
  };
}

export function buildCostsDashboardFromRows(
  rows: DashboardRow[],
  profiles: TopUserProfile[],
  input: { metric: CostMetric; days: number; limit: number; now: Date; todayStartIso: string; monthStartIso: string },
): CostsDashboard {
  const rangeRows = rows.filter((row) => row.created_at >= new Date(input.now.getTime() - input.days * 24 * 60 * 60 * 1000).toISOString());
  const monthRows = rows.filter((row) => row.created_at >= input.monthStartIso);

  return {
    overview: buildCostOverviewFromRows(monthRows, input.todayStartIso, input.metric),
    trend: buildCostTrendFromRows(rangeRows, input.days, input.metric, input.now),
    distribution: buildModelDistributionFromRows(rangeRows, input.metric),
    topUsers: buildTopUsersFromRows(rangeRows, profiles, input.metric, input.limit),
    cacheEfficiency: buildCacheEfficiencyFromRows(rangeRows, input.metric),
  };
}

// ============================================
// Router
// ============================================

export const costsRouter = router({
  getDashboard: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
      limit: z.number().min(1).max(50).default(10),
      timezone: z.string().optional().default('Asia/Shanghai'),
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<CostsDashboard> => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const rangeStart = new Date(now);
      rangeStart.setDate(rangeStart.getDate() - input.days);

      const queryStartIso = (rangeStart < monthStart ? rangeStart : monthStart).toISOString();
      const { data } = await ctx.supabase
        .from('token_stats')
        .select('user_id, model_used, total_credits, total_cost_usd, cached_tokens, input_tokens, created_at')
        .gte('created_at', queryStartIso);

      const rows = (data ?? []) as DashboardRow[];
      const topUserIds = buildTopUsersFromRows(
        rows.filter((row) => row.created_at >= rangeStart.toISOString()),
        [],
        input.metric,
        input.limit,
      ).map((user) => user.userId);

      const { data: profileData } = topUserIds.length
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname')
            .in('id', topUserIds)
        : { data: [] };

      return buildCostsDashboardFromRows(rows, (profileData ?? []) as TopUserProfile[], {
        metric: input.metric,
        days: input.days,
        limit: input.limit,
        now,
        todayStartIso: todayStart.toISOString(),
        monthStartIso: monthStart.toISOString(),
      });
    }),

  /**
   * 获取成本概览
   */
  getOverview: adminProcedure
    .input(z.object({
      timezone: z.string().optional().default('Asia/Shanghai'),
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<CostOverview> => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const { data: monthData } = await ctx.supabase
        .from('token_stats')
        .select('total_credits, total_cost_usd, created_at')
        .gte('created_at', monthStart.toISOString());

      return buildCostOverviewFromRows(
        (monthData ?? []) as CostRow[],
        todayStart.toISOString(),
        input.metric,
      );
    }),

  /**
   * 获取成本趋势
   */
  getCostTrend: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<DailyCost[]> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('total_credits, total_cost_usd, created_at')
        .gte('created_at', startDate.toISOString())
        .order('created_at', { ascending: true });

      // 按日期分组
      const dailyMap = new Map<string, { credits: number; usd: number; calls: number }>();

      // 初始化所有日期
      for (let i = 0; i < input.days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        dailyMap.set(dateStr!, { credits: 0, usd: 0, calls: 0 });
      }

      // 聚合数据
      data?.forEach(record => {
        const dateStr = new Date(record.created_at).toISOString().split('T')[0];
        const existing = dailyMap.get(dateStr!) ?? { credits: 0, usd: 0, calls: 0 };
        dailyMap.set(dateStr!, {
          credits: existing.credits + (record.total_credits ?? 0),
          usd: existing.usd + parseFloat(record.total_cost_usd ?? '0'),
          calls: existing.calls + 1,
        });
      });

      return Array.from(dailyMap.entries())
        .map(([date, data]) => ({
          date,
          calls: data.calls,
          credits: data.credits,
          usd: data.usd,
          cost: input.metric === 'usd' ? data.usd : data.credits,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }),

  /**
   * 获取模型分布
   */
  getModelDistribution: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(30),
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<ModelDistribution[]> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('model_used, total_credits, total_cost_usd')
        .gte('created_at', startDate.toISOString());

      // 按模型分组
      const modelMap = new Map<string, { calls: number; credits: number; usd: number }>();
      let totalCost = 0;

      data?.forEach(record => {
        const modelId = record.model_used ?? 'unknown';
        const existing = modelMap.get(modelId) ?? { calls: 0, credits: 0, usd: 0 };
        const credits = record.total_credits ?? 0;
        const usd = parseFloat(record.total_cost_usd ?? '0');
        const cost = input.metric === 'usd' ? usd : credits;
        modelMap.set(modelId, {
          calls: existing.calls + 1,
          credits: existing.credits + credits,
          usd: existing.usd + usd,
        });
        totalCost += cost;
      });

      return Array.from(modelMap.entries())
        .map(([modelId, data]) => ({
          modelId,
          modelName: getModelDisplayName(modelId),
          calls: data.calls,
          cost: input.metric === 'usd' ? data.usd : data.credits,
          credits: data.credits,
          usd: data.usd,
          percentage: totalCost > 0 ? Math.round(((input.metric === 'usd' ? data.usd : data.credits) / totalCost) * 100) : 0,
        }))
        .sort((a, b) => b.cost - a.cost);
    }),

  /**
   * 获取高消耗用户
   */
  getTopUsers: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(30),
      limit: z.number().min(1).max(50).default(10),
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<TopUser[]> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('user_id, total_credits, total_cost_usd')
        .gte('created_at', startDate.toISOString());

      const topUserIds = Array.from(
        new Set(
          buildTopUsersFromRows(
            (data ?? []) as TopUserAggregateRow[],
            [],
            input.metric,
            input.limit,
          ).map((user) => user.userId),
        ),
      );

      const { data: profileData } = topUserIds.length
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname')
            .in('id', topUserIds)
        : { data: [] };

      return buildTopUsersFromRows(
        (data ?? []) as TopUserAggregateRow[],
        (profileData ?? []) as TopUserProfile[],
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
          profiles!inner (
            email
          )
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + input.pageSize - 1);

      if (input.status !== 'all') {
        query = query.eq('status', input.status);
      }

      const { data, count, error } = await query;

      if (error) {
        logger.error('ai', 'costs_usage_logs_fetch_failed', {
          code: error.code,
        });
        return { logs: [], total: 0 };
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
        return { stats: [], total: 0 };
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
      metric: costMetricSchema.optional().default('usd'),
    }))
    .query(async ({ ctx, input }): Promise<{
      totalRequests: number;
      cacheHits: number;
      hitRate: number;
      savedCredits: number;
      savedUsd: number;
      savedValue: number;
    }> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('cached_tokens, input_tokens, total_credits, total_cost_usd')
        .gte('created_at', startDate.toISOString());

      const totalRequests = data?.length ?? 0;
      let cacheHits = 0;
      let totalCachedTokens = 0;
      let totalInputTokens = 0;

      data?.forEach(record => {
        const cachedTokens = record.cached_tokens ?? 0;
        const inputTokens = record.input_tokens ?? 0;
        if (cachedTokens > 0) {
          cacheHits++;
        }
        totalCachedTokens += cachedTokens;
        totalInputTokens += inputTokens;
      });

      // 估算节省的成本 (缓存读取成本约为正常成本的 10%)
      const savedCredits = totalInputTokens > 0
        ? Math.round((totalCachedTokens / totalInputTokens) * 0.9 * (data?.reduce((sum, r) => sum + (r.total_credits ?? 0), 0) ?? 0))
        : 0;
      const savedUsd = totalInputTokens > 0
        ? (totalCachedTokens / totalInputTokens) * 0.9 * (data?.reduce((sum, r) => sum + parseFloat(r.total_cost_usd ?? '0'), 0) ?? 0)
        : 0;

      return {
        totalRequests,
        cacheHits,
        hitRate: totalRequests > 0 ? Math.round((cacheHits / totalRequests) * 100) : 0,
        savedCredits,
        savedUsd,
        savedValue: input.metric === 'usd' ? savedUsd : savedCredits,
      };
    }),
});

// ============================================
// 辅助函数
// ============================================

function getModelDisplayName(modelId: string): string {
  const modelNames: Record<string, string> = {
    'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
    'claude-sonnet-4-20250514': 'Claude 4 Sonnet',
    'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
    'claude-3-opus-20240229': 'Claude 3 Opus',
  };
  return modelNames[modelId] ?? modelId;
}
