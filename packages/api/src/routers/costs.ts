/**
 * AI Costs Router - AI 成本监控路由
 *
 * 提供 AI 成本追踪和监控的 tRPC 端点
 */

import { router, protectedProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';

// ============================================
// 类型定义
// ============================================

export interface CostOverview {
  todayCost: number;
  todayCalls: number;
  monthCost: number;
  monthCalls: number;
  avgCostPerCall: number;
}

export interface ModelDistribution {
  modelId: string;
  modelName: string;
  calls: number;
  cost: number;
  percentage: number;
}

export interface DailyCost {
  date: string;
  cost: number;
  calls: number;
}

export interface TopUser {
  userId: string;
  email: string;
  nickname: string;
  totalCost: number;
  totalCalls: number;
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

// ============================================
// Router
// ============================================

export const costsRouter = router({
  /**
   * 获取成本概览
   */
  getOverview: adminProcedure
    .input(z.object({
      timezone: z.string().optional().default('Asia/Shanghai'),
    }))
    .query(async ({ ctx }): Promise<CostOverview> => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // 今日成本
      const { data: todayData } = await ctx.supabase
        .from('token_stats')
        .select('total_credits')
        .gte('created_at', todayStart.toISOString());

      const todayCost = todayData?.reduce((sum, r) => sum + (r.total_credits ?? 0), 0) ?? 0;
      const todayCalls = todayData?.length ?? 0;

      // 本月成本
      const { data: monthData } = await ctx.supabase
        .from('token_stats')
        .select('total_credits')
        .gte('created_at', monthStart.toISOString());

      const monthCost = monthData?.reduce((sum, r) => sum + (r.total_credits ?? 0), 0) ?? 0;
      const monthCalls = monthData?.length ?? 0;

      return {
        todayCost,
        todayCalls,
        monthCost,
        monthCalls,
        avgCostPerCall: monthCalls > 0 ? Math.round(monthCost / monthCalls) : 0,
      };
    }),

  /**
   * 获取成本趋势
   */
  getCostTrend: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
    }))
    .query(async ({ ctx, input }): Promise<DailyCost[]> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('total_credits, created_at')
        .gte('created_at', startDate.toISOString())
        .order('created_at', { ascending: true });

      // 按日期分组
      const dailyMap = new Map<string, { cost: number; calls: number }>();

      // 初始化所有日期
      for (let i = 0; i < input.days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        dailyMap.set(dateStr!, { cost: 0, calls: 0 });
      }

      // 聚合数据
      data?.forEach(record => {
        const dateStr = new Date(record.created_at).toISOString().split('T')[0];
        const existing = dailyMap.get(dateStr!) ?? { cost: 0, calls: 0 };
        dailyMap.set(dateStr!, {
          cost: existing.cost + (record.total_credits ?? 0),
          calls: existing.calls + 1,
        });
      });

      return Array.from(dailyMap.entries())
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }),

  /**
   * 获取模型分布
   */
  getModelDistribution: adminProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(30),
    }))
    .query(async ({ ctx, input }): Promise<ModelDistribution[]> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('model_used, total_credits')
        .gte('created_at', startDate.toISOString());

      // 按模型分组
      const modelMap = new Map<string, { calls: number; cost: number }>();
      let totalCost = 0;

      data?.forEach(record => {
        const modelId = record.model_used ?? 'unknown';
        const existing = modelMap.get(modelId) ?? { calls: 0, cost: 0 };
        const cost = record.total_credits ?? 0;
        modelMap.set(modelId, {
          calls: existing.calls + 1,
          cost: existing.cost + cost,
        });
        totalCost += cost;
      });

      return Array.from(modelMap.entries())
        .map(([modelId, data]) => ({
          modelId,
          modelName: getModelDisplayName(modelId),
          calls: data.calls,
          cost: data.cost,
          percentage: totalCost > 0 ? Math.round((data.cost / totalCost) * 100) : 0,
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
    }))
    .query(async ({ ctx, input }): Promise<TopUser[]> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select(`
          user_id,
          total_credits,
          profiles!inner (
            email,
            nickname
          )
        `)
        .gte('created_at', startDate.toISOString());

      // 按用户分组
      const userMap = new Map<string, {
        email: string;
        nickname: string;
        totalCost: number;
        totalCalls: number;
      }>();

      data?.forEach((record: any) => {
        const userId = record.user_id;
        const existing = userMap.get(userId) ?? {
          email: record.profiles?.email ?? 'unknown',
          nickname: record.profiles?.nickname ?? 'unknown',
          totalCost: 0,
          totalCalls: 0,
        };
        userMap.set(userId, {
          ...existing,
          totalCost: existing.totalCost + (record.total_credits ?? 0),
          totalCalls: existing.totalCalls + 1,
        });
      });

      return Array.from(userMap.entries())
        .map(([userId, data]) => ({ userId, ...data }))
        .sort((a, b) => b.totalCost - a.totalCost)
        .slice(0, input.limit);
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
        console.error('Failed to fetch usage logs:', error);
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
        console.error('Failed to fetch token stats:', error);
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
    }))
    .query(async ({ ctx, input }): Promise<{
      totalRequests: number;
      cacheHits: number;
      hitRate: number;
      savedCredits: number;
    }> => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const { data } = await ctx.supabase
        .from('token_stats')
        .select('cached_tokens, input_tokens, total_credits')
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

      return {
        totalRequests,
        cacheHits,
        hitRate: totalRequests > 0 ? Math.round((cacheHits / totalRequests) * 100) : 0,
        savedCredits,
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
