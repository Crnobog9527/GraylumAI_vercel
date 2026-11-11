/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { withRealModelUsedResult } from '../services/modelIdentity/usageAliases';
import { modelPriceView } from '../shared/modelPriceView';
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { readAllReportRows } from '../services/reportRows';
import {
  buildPerformanceCostStats,
  calculateTokenCacheHitRate,
  estimateCacheSavings,
} from '../services/performanceCostReport';
import { picoToUsd, usdToPico } from '../services/reportUsd';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminPerformanceProcedures = {
  /**
   * Get performance statistics with AI performance metrics
   */
  getPerformanceStats: adminProcedure
    .input(z.object({
      timeRange: z.enum(['7d', '14d', '30d']).default('14d'),
    }))
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      const now = new Date();
      const daysMap = { '7d': 7, '14d': 14, '30d': 30 };
      const days = daysMap[input.timeRange];
      const rangeStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const rangeStartIso = rangeStart.toISOString();
      const todayStartIso = todayStart.toISOString();
      const sevenDaysAgoIso = sevenDaysAgo.toISOString();
      const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();

      const [
        conversationTotalResult,
        recentConversationsResult,
        messageTotalResult,
        messageUserResult,
        messageAssistantResult,
        recentMessagesResult,
        ticketsResult,
        modelsResult,
        allTokenStatsResult,
        usageLogsResult,
      ] = await Promise.all([
        ctx.supabase
          .from('conversations')
          .select('id', { count: 'planned', head: true })
          .eq('is_deleted', false),
        ctx.supabase
          .from('conversations')
          .select('model_id, created_at')
          .eq('is_deleted', false)
          .gte('created_at', thirtyDaysAgoIso),
        ctx.supabase
          .from('messages')
          .select('id', { count: 'planned', head: true })
          .eq('is_deleted', false),
        ctx.supabase
          .from('messages')
          .select('id', { count: 'planned', head: true })
          .eq('is_deleted', false)
          .eq('role', 'user'),
        ctx.supabase
          .from('messages')
          .select('id', { count: 'planned', head: true })
          .eq('is_deleted', false)
          .eq('role', 'assistant'),
        ctx.supabase
          .from('messages')
          .select('role, created_at')
          .eq('is_deleted', false)
          .gte('created_at', thirtyDaysAgoIso),
        ctx.supabase
          .from('tickets')
          .select('status')
          .eq('is_deleted', false),
        ctx.supabase
          .from('ai_models')
          .select('id, name, model_id, provider, config, is_active'),
        withRealModelUsedResult(ctx.supabase, readAllReportRows((from, to) => ctx.supabase
          .from('token_stats') // MODEL-IDENTITY-GUARD: stored as aliases; joined and priced by the real model
          .select('model_used, total_credits, total_cost_usd, input_tokens, output_tokens, cached_tokens, cache_creation_tokens, created_at')
          .gte('created_at', rangeStartIso).order('id').range(from, to))),
        ctx.supabase
          .from('ai_usage_logs')
          .select('status, latency_ms, created_at')
          .gte('created_at', rangeStartIso),
      ]);

      const results = [
        conversationTotalResult,
        recentConversationsResult,
        messageTotalResult,
        messageUserResult,
        messageAssistantResult,
        recentMessagesResult,
        ticketsResult,
        modelsResult,
        allTokenStatsResult,
        usageLogsResult,
      ];

      for (const result of results) {
        if (result.error) {
          throw createAdminOperationError('读取性能统计', result.error);
        }
      }

      const recentConversations = recentConversationsResult.data ?? [];
      const recentMessages = recentMessagesResult.data ?? [];
      const tickets = ticketsResult.data ?? [];
      const models = modelsResult.data ?? [];
      const tokenStatsInRange = allTokenStatsResult.data ?? [];
      const usageLogs = usageLogsResult.data ?? [];

      const conversationStats = {
        total: conversationTotalResult.count ?? 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        inRange: 0,
      };

      const messageStats = {
        total: messageTotalResult.count ?? 0,
        userMessages: messageUserResult.count ?? 0,
        assistantMessages: messageAssistantResult.count ?? 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        inRange: 0,
      };

      const ticketStats = {
        total: tickets.length,
        open: 0,
        inProgress: 0,
        closed: 0,
      };

      const modelUsageByToken = new Map<string, {
        requestCount: number;
        credits: number;
        costPico: bigint;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
      }>();

      for (const stat of tokenStatsInRange) {
        const current = modelUsageByToken.get(stat.model_used) ?? {
          requestCount: 0,
          credits: 0,
          costPico: 0n,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        };
        current.requestCount += 1;
        current.credits += stat.total_credits ?? 0;
        current.costPico += usdToPico(stat.total_cost_usd);
        current.inputTokens += stat.input_tokens ?? 0;
        current.outputTokens += stat.output_tokens ?? 0;
        current.cachedTokens += stat.cached_tokens ?? 0;
        modelUsageByToken.set(stat.model_used, current);
      }

      const conversationsInRange: typeof recentConversations = [];
      for (const conversation of recentConversations) {
        if (conversation.created_at >= todayStartIso) {
          conversationStats.today += 1;
        }
        if (conversation.created_at >= sevenDaysAgoIso) {
          conversationStats.thisWeek += 1;
        }
        conversationStats.thisMonth += 1;

        if (conversation.created_at >= rangeStartIso) {
          conversationStats.inRange += 1;
          conversationsInRange.push(conversation);
        }
      }

      const messagesInRange: typeof recentMessages = [];
      for (const message of recentMessages) {
        if (message.created_at >= todayStartIso) {
          messageStats.today += 1;
        }
        if (message.created_at >= sevenDaysAgoIso) {
          messageStats.thisWeek += 1;
        }
        messageStats.thisMonth += 1;

        if (message.created_at >= rangeStartIso) {
          messageStats.inRange += 1;
          messagesInRange.push(message);
        }
      }

      for (const ticket of tickets) {
        if (ticket.status === 'open') {
          ticketStats.open += 1;
        } else if (ticket.status === 'in_progress') {
          ticketStats.inProgress += 1;
        } else if (ticket.status === 'closed') {
          ticketStats.closed += 1;
        }
      }

      const conversationsByModel = new Map<string, number>();
      for (const conversation of conversationsInRange) {
        if (!conversation.model_id) {
          continue;
        }
        conversationsByModel.set(
          conversation.model_id,
          (conversationsByModel.get(conversation.model_id) ?? 0) + 1
        );
      }

      const modelUsage = models.map((model) => {
        const usage = modelUsageByToken.get(model.model_id) ?? {
          requestCount: 0,
          credits: 0,
          costPico: 0n,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        };

        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          isActive: model.is_active,
          conversationCount: conversationsByModel.get(model.model_id) ?? 0,
          requestCount: usage.requestCount,
          creditsConsumed: usage.credits,
          totalCostUsd: picoToUsd(usage.costPico),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          pricing: modelPriceView(model),
        };
      });

      const dailyActivity: Record<string, { conversations: number; messages: number; requests: number }> = {};
      for (let i = 0; i < days; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        dailyActivity[dateKey] = { conversations: 0, messages: 0, requests: 0 };
      }

      for (const conversation of conversationsInRange) {
        const dateKey = new Date(conversation.created_at).toISOString().split('T')[0];
        if (dailyActivity[dateKey]) {
          dailyActivity[dateKey].conversations++;
        }
      }

      for (const message of messagesInRange) {
        const dateKey = new Date(message.created_at).toISOString().split('T')[0];
        if (dailyActivity[dateKey]) {
          dailyActivity[dateKey].messages++;
          if (message.role === 'assistant') {
            dailyActivity[dateKey].requests++;
          }
        }
      }

      const dailyChartData = Object.entries(dailyActivity)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          ...data,
        }));

      const rangeAssistantCount = dailyChartData.reduce(
        (sum, day) => sum + day.requests,
        0,
      );

      const averages = {
        messagesPerConversation: conversationStats.total > 0
          ? Math.round(messageStats.total / conversationStats.total)
          : 0,
        conversationsPerDay: Math.round(conversationStats.inRange / days),
        messagesPerDay: Math.round(messageStats.inRange / days),
        requestsPerDay: Math.round(rangeAssistantCount / days),
      };

      const totalRequests = messageAssistantResult.count ?? 0;
      const rangeRequests = rangeAssistantCount;

      const inputTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.input_tokens ?? 0), 0);
      const outputTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.output_tokens ?? 0), 0);
      const cacheReadTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.cached_tokens ?? 0), 0);
      const cacheCreationTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.cache_creation_tokens ?? 0), 0);

      const cacheSavings = estimateCacheSavings(tokenStatsInRange, models);

      const successLogs = usageLogs.filter((log) => log.status === 'success');
      const failedLogs = usageLogs.filter((log) => log.status !== 'success');
      const totalLogs = usageLogs.length;
      const errorRate = totalLogs > 0 ? (failedLogs.length / totalLogs) * 100 : 0;

      const latencies = successLogs
        .map((log) => log.latency_ms)
        .filter((latency): latency is number => latency !== null && latency !== undefined)
        .sort((a, b) => a - b);

      const avgResponseTime = latencies.length > 0
        ? latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length
        : 0;

      const p95Index = Math.floor(latencies.length * 0.95);
      const p95ResponseTime = latencies.length > 0
        ? latencies[p95Index] ?? latencies[latencies.length - 1]
        : 0;

      let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (errorRate > 2 || avgResponseTime > 2000) healthStatus = 'critical';
      else if (errorRate > 1 || avgResponseTime > 1500) healthStatus = 'warning';

      const aiPerformance = {
        totalRequests,
        rangeRequests,
        avgResponseTime: Math.round(avgResponseTime),
        p95ResponseTime: Math.round(p95ResponseTime),
        errorRate: parseFloat(errorRate.toFixed(2)),
        cacheHitRate: calculateTokenCacheHitRate(tokenStatsInRange),
        healthStatus,
      };

      const tokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };

      const costStats = buildPerformanceCostStats(tokenStatsInRange, days, cacheSavings);

      const result = {
        timeRange: input.timeRange,
        conversations: conversationStats,
        messages: messageStats,
        tickets: ticketStats,
        modelUsage,
        dailyChart: dailyChartData,
        averages,
        aiPerformance,
        tokenUsage,
        costStats,
      };

      logAdminEndpointMetric('admin.getPerformanceStats', startedAt, {
        queryCount: 10,
        countStrategy: 'planned',
        timeRange: input.timeRange,
        conversationTotal: result.conversations.total,
        messageTotal: result.messages.total,
      });

      return result;
    }),
};
