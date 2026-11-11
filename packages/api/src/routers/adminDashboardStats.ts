/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { readAdminActivity, readAdminDashboardStats } from '../services/adminActivity';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

const DAY_MS = 24 * 60 * 60 * 1000;

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminDashboardProcedures = {
  /**
   * Get enhanced dashboard statistics
   * Returns comprehensive overview for the admin dashboard
   */
  getStatistics: adminProcedure.query(async ({ ctx }) => {
    const startedAt = Date.now();
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const weekStart = new Date(now.getTime() - 7 * DAY_MS);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Users, tickets and the ledger are counted in the database (admin_dashboard_stats) and conversations come from the per-turn
    // core (turn_admin_activity): an unpaged read is cut at the row cap, and the retired chat tables get no new rows.
    const [dashboard, activity, recentUsersResult, modelsResult, topUsersResult] = await Promise.all([
      readAdminDashboardStats(ctx.supabase, todayStart, weekStart, monthStart),
      readAdminActivity(ctx.supabase, weekStart, new Date(now.getTime() + 60_000)),
      // Recent users (last 10)
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, role, credits, created_at')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(10),
      // Active models
      ctx.supabase
        .from('ai_models')
        .select('id, name, model_id, is_active')
        .eq('is_active', 'true'),
      // Top users by credits held
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, credits')
        .eq('is_deleted', false)
        .order('credits', { ascending: false })
        .limit(5),
    ]).catch((error: unknown) => { throw createAdminOperationError('读取后台统计', error); });
    for (const result of [recentUsersResult, modelsResult, topUsersResult]) {
      if (result.error) throw createAdminOperationError('读取后台统计', result.error);
    }

    const today = todayStart.toISOString().slice(0, 10);
    const conversationStats = {
      total: activity.conversations.total,
      today: activity.conversations.days.reduce((sum, row) => sum + (row.date === today ? row.count : 0), 0),
      thisWeek: activity.conversations.days.reduce((sum, row) => sum + row.count, 0),
    };
    const ticketStats = dashboard.tickets;

    // Spend is credits actually charged (ledger_type spend): the per-turn core writes them as type 'consumption', never 'deduction'.
    const typeAmount = (type: string) => dashboard.ledger.byType[type]?.amount ?? 0;
    const transactionStats = {
      totalDeductions: dashboard.ledger.spent,
      totalAdditions: typeAmount('addition'),
      totalCheckins: typeAmount('checkin'),
      totalPurchases: typeAmount('purchase'),
      totalRefunds: typeAmount('refund'),
    };

    // Trend of the last 7 days: credits granted and credits actually spent per UTC day.
    const ledgerDays = new Map(dashboard.ledger.days.map((row) => [row.date, row]));
    const trendData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now.getTime() - i * DAY_MS);
      const dateStr = date.toISOString().split('T')[0];
      trendData.push({
        date: dateStr,
        day: date.toLocaleDateString('zh-CN', { weekday: 'short' }),
        additions: ledgerDays.get(dateStr)?.granted ?? 0,
        deductions: ledgerDays.get(dateStr)?.spent ?? 0,
      });
    }

    // System health calculation
    const openTicketRatio = ticketStats.total > 0 ? ticketStats.open / ticketStats.total : 0;
    const systemHealth = openTicketRatio > 0.5 ? 'warning' : openTicketRatio > 0.3 ? 'attention' : 'healthy';

    const result = {
      users: {
        total: dashboard.users.total,
        today: dashboard.users.today,
        thisWeek: dashboard.users.week,
        thisMonth: dashboard.users.month,
        recentUsers: recentUsersResult.data ?? [],
        topUsers: topUsersResult.data ?? [],
      },
      conversations: conversationStats,
      tickets: ticketStats,
      credits: {
        totalInSystem: dashboard.users.credits,
        transactions: transactionStats,
      },
      models: {
        activeCount: modelsResult.data?.length ?? 0,
        list: modelsResult.data ?? [],
      },
      trends: trendData,
      systemHealth,
    };

    logAdminEndpointMetric('admin.getStatistics', startedAt, {
      queryCount: 5,
      countStrategy: 'database',
      userCount: result.users.total,
      conversationTotal: result.conversations.total,
    });

    return result;
  }),
};
