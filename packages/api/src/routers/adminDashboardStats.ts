/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { logAdminEndpointMetric } from './adminShared';

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminDashboardProcedures = {
  /**
   * Get enhanced dashboard statistics
   * Returns comprehensive overview for the admin dashboard
   */
  getStatistics: adminProcedure.query(async ({ ctx }) => {
    const startedAt = Date.now();
    // Calculate date ranges
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Fetch all statistics in parallel for better performance
    const [
      profilesAggregateResult,
      ticketsResult,
      recentUsersResult,
      conversationsTotal,
      recentConversationsResult,
      transactionsResult,
      modelsResult,
      creditTransactionsResult,
      topUsersResult,
    ] = await Promise.all([
      // Aggregate user counts and credits from one shared dataset
      ctx.supabase
        .from('profiles')
        .select('id, created_at, credits')
        .eq('is_deleted', false),

      // Tickets by status
      ctx.supabase
        .from('tickets')
        .select('status')
        .eq('is_deleted', false),

      // Recent users (last 10)
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, role, credits, created_at')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(10),

      // Total conversations
      ctx.supabase
        .from('conversations')
        .select('id', { count: 'planned', head: true })
        .eq('is_deleted', false),

      // Recent conversations for today/week rollups
      ctx.supabase
        .from('conversations')
        .select('created_at')
        .eq('is_deleted', false)
        .gte('created_at', weekStart),

      // Recent transactions for trends (last 7 days)
      ctx.supabase
        .from('credit_transactions')
        .select('amount, type, created_at')
        .gte('created_at', weekStart)
        .order('created_at', { ascending: true }),

      // Active models with usage
      ctx.supabase
        .from('ai_models')
        .select('id, name, model_id, is_active')
        .eq('is_active', 'true'),

      // Credit transactions summary
      ctx.supabase.from('credit_transactions').select('type, amount'),

      // Top users by credits spent (from transactions)
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, credits')
        .eq('is_deleted', false)
        .order('credits', { ascending: false })
        .limit(5),
    ]);

    const profiles = profilesAggregateResult.data ?? [];
    const totalCredits = profiles.reduce((sum, user) => sum + (user.credits ?? 0), 0);
    const userStats = {
      total: profiles.length,
      today: 0,
      thisWeek: 0,
      thisMonth: 0,
    };

    for (const profile of profiles) {
      if (profile.created_at >= todayStart) {
        userStats.today += 1;
      }
      if (profile.created_at >= weekStart) {
        userStats.thisWeek += 1;
      }
      if (profile.created_at >= monthStart) {
        userStats.thisMonth += 1;
      }
    }

    const recentConversations = recentConversationsResult.data ?? [];
    const conversationStats = {
      total: conversationsTotal.count ?? 0,
      today: 0,
      thisWeek: recentConversations.length,
    };

    for (const conversation of recentConversations) {
      if (conversation.created_at >= todayStart) {
        conversationStats.today += 1;
      }
    }

    // Calculate ticket statistics
    const ticketStats = {
      total: ticketsResult.data?.length ?? 0,
      open: ticketsResult.data?.filter(t => t.status === 'open').length ?? 0,
      inProgress: ticketsResult.data?.filter(t => t.status === 'in_progress').length ?? 0,
      closed: ticketsResult.data?.filter(t => t.status === 'closed').length ?? 0,
    };

    // Calculate credit transactions stats
    const transactionStats = {
      totalDeductions: 0,
      totalAdditions: 0,
      totalCheckins: 0,
      totalPurchases: 0,
      totalRefunds: 0,
    };
    creditTransactionsResult.data?.forEach((t: { type: string; amount: number }) => {
      if (t.type === 'deduction') transactionStats.totalDeductions += Math.abs(t.amount);
      else if (t.type === 'addition') transactionStats.totalAdditions += t.amount;
      else if (t.type === 'checkin') transactionStats.totalCheckins += t.amount;
      else if (t.type === 'purchase') transactionStats.totalPurchases += t.amount;
      else if (t.type === 'refund') transactionStats.totalRefunds += t.amount;
    });

    // Generate trend data for last 7 days
    const trendData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const dayTransactions = transactionsResult.data?.filter((t: { created_at: string }) =>
        t.created_at.startsWith(dateStr)
      ) ?? [];

      const additions = dayTransactions
        .filter((t: { type: string }) =>
          t.type === 'addition' || t.type === 'purchase' || t.type === 'refund' || t.type === 'checkin'
        )
        .reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
      const deductions = dayTransactions
        .filter((t: { type: string }) => t.type === 'deduction')
        .reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);

      trendData.push({
        date: dateStr,
        day: date.toLocaleDateString('zh-CN', { weekday: 'short' }),
        additions,
        deductions,
      });
    }

    // System health calculation
    const openTicketRatio = ticketStats.total > 0 ? ticketStats.open / ticketStats.total : 0;
    const systemHealth = openTicketRatio > 0.5 ? 'warning' : openTicketRatio > 0.3 ? 'attention' : 'healthy';

    const result = {
      users: {
        total: userStats.total,
        today: userStats.today,
        thisWeek: userStats.thisWeek,
        thisMonth: userStats.thisMonth,
        recentUsers: recentUsersResult.data ?? [],
        topUsers: topUsersResult.data ?? [],
      },
      conversations: conversationStats,
      tickets: ticketStats,
      credits: {
        totalInSystem: totalCredits,
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
      queryCount: 9,
      countStrategy: 'planned',
      userCount: result.users.total,
      conversationTotal: result.conversations.total,
    });

    return result;
  }),
};
