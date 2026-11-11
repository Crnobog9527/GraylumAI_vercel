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
import { readAdminActivity, readUsageDays, requestCount, sumDaysSince, usageDaysAsTokenRows } from '../services/adminActivity';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

/** A token_stats row of the retired path (one request), or one model-and-day group of the per-turn core (`requests` of them). */
type PerformanceTokenRow = { model_used: string; total_credits: number | null; total_cost_usd: string | number | null;
  input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; cache_creation_tokens: number | null;
  created_at: string; requests?: number };

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

      // Conversations, messages and finished calls come from the per-turn core (turn_admin_activity, turn_admin_usage_days): the
      // retired chat tables get no new rows. Charts cover 30 days; requests, tokens and cost cover the chosen range.
      const readUntil = new Date(now.getTime() + 60_000);
      const [activity, usageDays, ticketsResult, modelsResult, legacyTokenStatsResult] = await Promise.all([
        readAdminActivity(ctx.supabase, thirtyDaysAgo, readUntil, rangeStart),
        readUsageDays(ctx.supabase, rangeStart, readUntil, rangeStart),
        ctx.supabase
          .from('tickets')
          .select('status')
          .eq('is_deleted', false),
        ctx.supabase
          .from('ai_models')
          .select('id, name, model_id, provider, config, is_active'),
        // Rows the retired path left in token_stats (none on a database built from files).
        withRealModelUsedResult(ctx.supabase, readAllReportRows((from, to) => ctx.supabase
          .from('token_stats') // MODEL-IDENTITY-GUARD: stored as aliases; joined and priced by the real model
          .select('model_used, total_credits, total_cost_usd, input_tokens, output_tokens, cached_tokens, cache_creation_tokens, created_at')
          .gte('created_at', rangeStartIso).order('id').range(from, to))),
      ]).catch((error: unknown) => { throw createAdminOperationError('读取性能统计', error); });

      for (const result of [ticketsResult, modelsResult, legacyTokenStatsResult]) {
        if (result.error) {
          throw createAdminOperationError('读取性能统计', result.error);
        }
      }

      const tickets = ticketsResult.data ?? [];
      const models = modelsResult.data ?? [];
      const tokenStatsInRange: PerformanceTokenRow[] = [...(legacyTokenStatsResult.data ?? []), ...usageDaysAsTokenRows(usageDays)];
      const requestsInRange = requestCount(tokenStatsInRange);

      // The core answers per UTC day, so "today", "this week" and the range start at a day boundary.
      const conversationDays = activity.conversations.days;
      const messageDays = activity.messages.days;
      const conversationsSince = (since: Date) => sumDaysSince(conversationDays, since, row => row.count);
      const messagesSince = (since: Date) => sumDaysSince(messageDays, since, row => row.user + row.assistant);

      const conversationStats = {
        total: activity.conversations.total,
        today: conversationsSince(todayStart),
        thisWeek: conversationsSince(sevenDaysAgo),
        thisMonth: conversationsSince(thirtyDaysAgo),
        inRange: conversationsSince(rangeStart),
      };

      const messageStats = {
        total: activity.messages.user + activity.messages.assistant,
        userMessages: activity.messages.user,
        assistantMessages: activity.messages.assistant,
        today: messagesSince(todayStart),
        thisWeek: messagesSince(sevenDaysAgo),
        thisMonth: messagesSince(thirtyDaysAgo),
        inRange: messagesSince(rangeStart),
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
        current.requestCount += stat.requests ?? 1;
        current.credits += stat.total_credits ?? 0;
        current.costPico += usdToPico(stat.total_cost_usd);
        current.inputTokens += stat.input_tokens ?? 0;
        current.outputTokens += stat.output_tokens ?? 0;
        current.cachedTokens += stat.cached_tokens ?? 0;
        modelUsageByToken.set(stat.model_used, current);
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

      // A conversation belongs to the model of its first turn (the provider model name).
      const rangeDay = rangeStartIso.slice(0, 10);
      const conversationsByModel = new Map<string, number>();
      for (const row of conversationDays) {
        if (row.date < rangeDay) continue;
        conversationsByModel.set(row.model, (conversationsByModel.get(row.model) ?? 0) + row.count);
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

      for (const row of conversationDays) {
        if (dailyActivity[row.date]) dailyActivity[row.date].conversations += row.count;
      }

      for (const row of messageDays) {
        if (dailyActivity[row.date]) {
          dailyActivity[row.date].messages += row.user + row.assistant;
          dailyActivity[row.date].requests += row.assistant;
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

      const totalRequests = activity.messages.assistant;
      const rangeRequests = rangeAssistantCount;

      const inputTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.input_tokens ?? 0), 0);
      const outputTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.output_tokens ?? 0), 0);
      const cacheReadTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.cached_tokens ?? 0), 0);
      const cacheCreationTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.cache_creation_tokens ?? 0), 0);

      const cacheSavings = estimateCacheSavings(tokenStatsInRange, models);

      // Finished model calls of the range: failed ones over all finished ones; duration from dispatch to record, over successes.
      const { finished, failed } = activity.calls;
      const errorRate = finished > 0 ? (failed / finished) * 100 : 0;
      const avgResponseTime = activity.calls.avgMs ?? 0;
      const p95ResponseTime = activity.calls.p95Ms ?? 0;

      // Health follows the error rate only. The duration is a whole model call (a streamed answer takes many seconds), so the
      // retired path's 1.5 s and 2 s limits would mark every day critical.
      let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (errorRate > 2) healthStatus = 'critical';
      else if (errorRate > 1) healthStatus = 'warning';

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

      const costStats = buildPerformanceCostStats(tokenStatsInRange, days, cacheSavings, requestsInRange);

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
        queryCount: 5,
        countStrategy: 'database',
        timeRange: input.timeRange,
        conversationTotal: result.conversations.total,
        messageTotal: result.messages.total,
      });

      return result;
    }),
};
