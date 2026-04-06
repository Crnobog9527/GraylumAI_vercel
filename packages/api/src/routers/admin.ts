import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { issueSignedAttachmentUrls } from '../lib/ticketAttachments';
import { ConversationCleanupService } from '../services/conversationCleanup';
import {
  getAdminMembershipOverrideErrorMessage,
  isStripeManagedSubscriptionActive,
} from '../services/subscriptionOverrides';
import {
  finishScheduledJobRun,
  getLatestScheduledJobRun,
  SCHEDULED_JOB_KEYS,
  startScheduledJobRun,
} from '../services/scheduledJobRuns';

const promptCategorySchema = z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']);
const promptPlatformSchema = z.enum(['all', 'web', 'mobile', 'desktop', 'api']);
const promptBatchPatchSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  systemPrompt: z.string().max(10000).nullable().optional(),
  userPromptTemplate: z.string().max(10000).nullable().optional(),
  modelId: z.string().uuid().nullable().optional(),
  platform: promptPlatformSchema.optional(),
  features: z.array(z.string()).nullable().optional(),
  userQuestions: z.array(z.string()).nullable().optional(),
  icon: z.string().max(50).optional(),
  category: promptCategorySchema.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: 'At least one patch field is required' },
);

export const adminRouter = router({
  /**
   * Get enhanced dashboard statistics
   * Returns comprehensive overview for the admin dashboard
   */
  getStatistics: adminProcedure.query(async ({ ctx }) => {
    // Calculate date ranges
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Fetch all statistics in parallel for better performance
    const [
      usersResult,
      ticketsResult,
      invitationsResult,
      creditsResult,
      recentUsersResult,
      // Time-based stats
      usersToday,
      usersThisWeek,
      usersThisMonth,
      // Conversations stats
      conversationsTotal,
      conversationsToday,
      conversationsThisWeek,
      // Transactions for trends
      transactionsResult,
      // Models for usage stats
      modelsResult,
      // Credit transactions by type
      creditTransactionsResult,
      // Top active users (by conversations)
      topUsersResult,
    ] = await Promise.all([
      // Total users count
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_deleted', false),

      // Tickets by status
      ctx.supabase.from('tickets').select('status').eq('is_deleted', false),

      // Invitations by status
      ctx.supabase.from('invitations').select('status'),

      // Total credits in system
      ctx.supabase.from('profiles').select('credits').eq('is_deleted', false),

      // Recent users (last 10)
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, role, credits, created_at')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(10),

      // Users registered today
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_deleted', false).gte('created_at', todayStart),

      // Users registered this week
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_deleted', false).gte('created_at', weekStart),

      // Users registered this month
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_deleted', false).gte('created_at', monthStart),

      // Total conversations
      ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('is_deleted', false),

      // Conversations today
      ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('is_deleted', false).gte('created_at', todayStart),

      // Conversations this week
      ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('is_deleted', false).gte('created_at', weekStart),

      // Recent transactions for trends (last 30 days)
      ctx.supabase
        .from('credit_transactions')
        .select('amount, type, created_at')
        .gte('created_at', new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString())
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

    // Calculate ticket statistics
    const ticketStats = {
      total: ticketsResult.data?.length ?? 0,
      open: ticketsResult.data?.filter(t => t.status === 'open').length ?? 0,
      inProgress: ticketsResult.data?.filter(t => t.status === 'in_progress').length ?? 0,
      closed: ticketsResult.data?.filter(t => t.status === 'closed').length ?? 0,
    };

    // Calculate invitation statistics
    const invitationStats = {
      total: invitationsResult.data?.length ?? 0,
      active: invitationsResult.data?.filter(i => i.status === 'active').length ?? 0,
      used: invitationsResult.data?.filter(i => i.status === 'used').length ?? 0,
      expired: invitationsResult.data?.filter(i => i.status === 'expired').length ?? 0,
    };

    // Calculate total credits
    const totalCredits = creditsResult.data?.reduce((sum, user) => sum + (user.credits ?? 0), 0) ?? 0;

    // Calculate credit transactions stats
    const transactionStats = {
      totalDeductions: 0,
      totalAdditions: 0,
      totalPurchases: 0,
      totalRefunds: 0,
    };
    creditTransactionsResult.data?.forEach((t: { type: string; amount: number }) => {
      if (t.type === 'deduction') transactionStats.totalDeductions += Math.abs(t.amount);
      else if (t.type === 'addition') transactionStats.totalAdditions += t.amount;
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

    return {
      users: {
        total: usersResult.count ?? 0,
        today: usersToday.count ?? 0,
        thisWeek: usersThisWeek.count ?? 0,
        thisMonth: usersThisMonth.count ?? 0,
        recentUsers: recentUsersResult.data ?? [],
        topUsers: topUsersResult.data ?? [],
      },
      conversations: {
        total: conversationsTotal.count ?? 0,
        today: conversationsToday.count ?? 0,
        thisWeek: conversationsThisWeek.count ?? 0,
      },
      tickets: ticketStats,
      invitations: invitationStats,
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
  }),

  /**
   * Get all users (for admin management)
   */
  getAllUsers: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      search: z.string().optional(),
      status: z.enum(['active', 'disabled', 'banned']).optional(),
      membershipLevel: z.enum(['free', 'pro', 'gold']).optional(),
      role: z.enum(['user', 'admin']).optional(),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, role, status, membership_level, credits, last_login_at, last_ip, created_at', { count: 'exact' })
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      // Apply search filter if provided
      if (input.search) {
        query = query.or(`email.ilike.%${input.search}%,nickname.ilike.%${input.search}%`);
      }

      // Apply status filter
      if (input.status) {
        query = query.eq('status', input.status);
      }

      // Apply membership level filter
      if (input.membershipLevel) {
        query = query.eq('membership_level', input.membershipLevel);
      }

      // Apply role filter
      if (input.role) {
        query = query.eq('role', input.role);
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return {
        users: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
      };
    }),

  /**
   * Search users for admin filters and selectors
   */
  searchUsers: adminProcedure
    .input(z.object({
      query: z.string().trim().min(1),
      limit: z.number().min(1).max(20).default(5),
    }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url')
        .eq('is_deleted', false)
        .or(`email.ilike.%${input.query}%,nickname.ilike.%${input.query}%`)
        .order('created_at', { ascending: false })
        .limit(input.limit);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data ?? [];
    }),

  /**
   * Update user role
   */
  updateUserRole: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      role: z.enum(['user', 'admin']),
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current role
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('role, nickname, email')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const previousRole = profile.role;

      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ role: input.role })
        .eq('id', input.userId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Log the activity
      await ctx.supabase.from('user_activity_logs').insert({
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `角色变更: ${previousRole} → ${input.role}`,
        action_type: 'role_change',
        details: {
          previousRole,
          newRole: input.role,
          reason: input.reason,
        },
      });

      return data;
    }),

  /**
   * Get all tickets (for admin to manage all users' tickets)
   */
  getAllTickets: adminProcedure
    .input(z.object({
      status: z.enum(['open', 'in_progress', 'closed']).optional(),
      category: z.enum(['bug', 'feature', 'question', 'account', 'billing', 'other']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      // 查询工单（不使用外键关联，改为分步查询以避免 schema cache 问题）
      let query = ctx.supabase
        .from('tickets')
        .select('*', { count: 'exact' })
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.status) {
        query = query.eq('status', input.status);
      }
      if (input.category) {
        query = query.eq('category', input.category);
      }
      if (input.priority) {
        query = query.eq('priority', input.priority);
      }

      const { data: ticketsData, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      let statusCountsQuery = ctx.supabase
        .from('tickets')
        .select('status')
        .eq('is_deleted', false);

      if (input.category) {
        statusCountsQuery = statusCountsQuery.eq('category', input.category);
      }
      if (input.priority) {
        statusCountsQuery = statusCountsQuery.eq('priority', input.priority);
      }

      const { data: statusCountRows, error: statusCountsError } = await statusCountsQuery;

      if (statusCountsError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: statusCountsError.message });
      }

      const statusCounts = {
        all: statusCountRows?.length ?? 0,
        open: statusCountRows?.filter(t => t.status === 'open').length ?? 0,
        in_progress: statusCountRows?.filter(t => t.status === 'in_progress').length ?? 0,
        closed: statusCountRows?.filter(t => t.status === 'closed').length ?? 0,
      };

      if (!ticketsData || ticketsData.length === 0) {
        return {
          tickets: [],
          total: count ?? 0,
          hasMore: false,
          statusCounts,
        };
      }

      // 获取所有工单的用户 ID
      const userIds = Array.from(new Set(ticketsData.map(t => t.user_id).filter(Boolean)));
      const ticketIds = ticketsData.map(t => t.id);

      // 分步查询：获取用户信息
      const { data: usersData } = userIds.length > 0
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname, avatar_url, role')
            .in('id', userIds)
        : { data: [] };

      // 分步查询：获取工单回复
      const { data: repliesData } = await ctx.supabase
        .from('ticket_replies')
        .select('*')
        .in('ticket_id', ticketIds)
        .order('created_at', { ascending: true });

      // 获取回复者用户信息
      const replyUserIds = Array.from(new Set((repliesData ?? []).map(r => r.user_id).filter(Boolean)));
      const { data: replyUsersData } = replyUserIds.length > 0
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname, avatar_url, role')
            .in('id', replyUserIds)
        : { data: [] };

      // 构建用户映射
      const usersMap = new Map((usersData ?? []).map(u => [u.id, u]));
      const replyUsersMap = new Map((replyUsersData ?? []).map(u => [u.id, u]));

      // 组装工单数据
      const tickets = await Promise.all(ticketsData.map(async (ticket) => ({
        ...ticket,
        attachments: await issueSignedAttachmentUrls(ctx.supabaseAdmin, ticket.attachments),
        user: ticket.user_id ? usersMap.get(ticket.user_id) ?? null : null,
        ticket_replies: await Promise.all((repliesData ?? [])
          .filter(r => r.ticket_id === ticket.id)
          .map(async (reply) => ({
            ...reply,
            attachments: await issueSignedAttachmentUrls(ctx.supabaseAdmin, reply.attachments),
            user: reply.user_id ? replyUsersMap.get(reply.user_id) ?? null : null,
          }))),
      })));

      return {
        tickets,
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        statusCounts,
      };
    }),

  /**
   * Update ticket status (admin can update any ticket)
   */
  updateTicketStatus: adminProcedure
    .input(z.object({
      ticketId: z.string().uuid(),
      status: z.enum(['open', 'in_progress', 'closed']),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('tickets')
        .update({
          status: input.status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.ticketId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Admin reply to ticket
   */
  replyToTicket: adminProcedure
    .input(z.object({
      ticketId: z.string().uuid(),
      content: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('ticket_replies')
        .insert({
          ticket_id: input.ticketId,
          user_id: ctx.profileId,
          content: input.content,
          is_admin: 'true', // 标记为管理员回复
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // 同时更新工单的 updated_at
      await ctx.supabase
        .from('tickets')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', input.ticketId);

      return data;
    }),

  /**
   * Get all credit transactions (for admin)
   */
  getAllTransactions: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      type: z.enum(['deduction', 'addition', 'checkin', 'purchase', 'refund']).optional(),
      userId: z.string().uuid().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('credit_transactions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.type) {
        query = query.eq('type', input.type);
      }

      if (input.userId) {
        query = query.eq('user_id', input.userId);
      }

      if (input.startDate) {
        query = query.gte('created_at', input.startDate);
      }

      if (input.endDate) {
        query = query.lte('created_at', input.endDate);
      }

      let statsQuery = ctx.supabase
        .from('credit_transactions')
        .select('type, amount');

      if (input.type) {
        statsQuery = statsQuery.eq('type', input.type);
      }

      if (input.userId) {
        statsQuery = statsQuery.eq('user_id', input.userId);
      }

      if (input.startDate) {
        statsQuery = statsQuery.gte('created_at', input.startDate);
      }

      if (input.endDate) {
        statsQuery = statsQuery.lte('created_at', input.endDate);
      }

      const [transactionsResult, statsResult] = await Promise.all([
        query,
        statsQuery,
      ]);

      const { data, error, count } = transactionsResult;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      const userIds = Array.from(new Set((data ?? []).map((transaction) => transaction.user_id).filter(Boolean)));
      let profilesById = new Map<string, {
        id: string;
        email: string | null;
        nickname: string | null;
        avatar_url: string | null;
      }>();

      if (userIds.length > 0) {
        const { data: profiles, error: profilesError } = await ctx.supabase
          .from('profiles')
          .select('id, email, nickname, avatar_url')
          .in('id', userIds);

        if (profilesError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: profilesError.message });
        }

        profilesById = new Map(
          (profiles ?? []).map((profile) => [profile.id, profile]),
        );
      }

      const stats = {
        totalAdditions: 0,
        totalCheckins: 0,
        totalDeductions: 0,
        totalPurchases: 0,
        totalRefunds: 0,
      };

      statsResult.data?.forEach((t: { type: string; amount: number }) => {
        if (t.type === 'addition') stats.totalAdditions += t.amount;
        else if (t.type === 'checkin') stats.totalCheckins += t.amount;
        else if (t.type === 'deduction') stats.totalDeductions += Math.abs(t.amount);
        else if (t.type === 'purchase') stats.totalPurchases += t.amount;
        else if (t.type === 'refund') stats.totalRefunds += t.amount;
      });

      return {
        transactions: (data ?? []).map((transaction) => ({
          ...transaction,
          profiles: profilesById.get(transaction.user_id) ?? null,
        })),
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
    }),

  /**
   * Adjust user credits (add or deduct)
   */
  adjustUserCredits: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      amount: z.number().int(), // Positive to add, negative to deduct
      reason: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current credits
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('credits')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const newCredits = Math.max(0, profile.credits + input.amount);
      const actualAdjustment = newCredits - profile.credits;

      // Update credits
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ credits: newCredits })
        .eq('id', input.userId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      if (actualAdjustment !== 0) {
        await ctx.supabase.from('credit_transactions').insert({
          user_id: input.userId,
          amount: actualAdjustment,
          type: actualAdjustment > 0 ? 'addition' : 'deduction',
          description: `[Admin] ${input.reason}`,
        });
      }

      // Log the activity
      await ctx.supabase.from('user_activity_logs').insert({
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `积分调整: ${actualAdjustment > 0 ? '+' : ''}${actualAdjustment}`,
        action_type: 'credit_adjustment',
        details: {
          previousCredits: profile.credits,
          newCredits,
          requestedAdjustment: input.amount,
          appliedAdjustment: actualAdjustment,
          reason: input.reason,
        },
      });

      return {
        previousCredits: profile.credits,
        newCredits,
        adjustment: actualAdjustment,
      };
    }),

  // ============================================
  // User Management (Enhanced)
  // ============================================

  /**
   * Get detailed user info with usage statistics
   */
  getUserDetails: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      // Get user profile with all fields
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('*')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      // Get usage statistics
      const [
        conversationsResult,
        creditsSpentResult,
        ticketsResult,
      ] = await Promise.all([
        // Fetch conversation IDs first; message count must be based on these IDs
        ctx.supabase
          .from('conversations')
          .select('id')
          .eq('user_id', input.userId),

        // Credits spent (deductions)
        ctx.supabase
          .from('credit_transactions')
          .select('amount')
          .eq('user_id', input.userId)
          .eq('type', 'deduction'),

        // Tickets created
        ctx.supabase
          .from('tickets')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', input.userId),
      ]);

      if (conversationsResult.error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: conversationsResult.error.message });
      }
      if (creditsSpentResult.error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: creditsSpentResult.error.message });
      }
      if (ticketsResult.error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: ticketsResult.error.message });
      }

      const conversationIds = (conversationsResult.data ?? []).map((conversation) => conversation.id);
      let totalMessages = 0;

      if (conversationIds.length > 0) {
        const { count: messageCount, error: messageError } = await ctx.supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', conversationIds);

        if (messageError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: messageError.message });
        }

        totalMessages = messageCount ?? 0;
      }

      // Calculate total credits spent
      const totalCreditsSpent = creditsSpentResult.data?.reduce(
        (sum, t) => sum + Math.abs(t.amount), 0
      ) ?? 0;

      // Get recent activity logs
      const { data: recentLogs } = await ctx.supabase
        .from('user_activity_logs')
        .select('*')
        .eq('user_id', input.userId)
        .order('created_at', { ascending: false })
        .limit(10);

      return {
        profile,
        stats: {
          totalConversations: conversationsResult.data?.length ?? 0,
          totalMessages,
          totalCreditsSpent,
          totalTickets: ticketsResult.count ?? 0,
        },
        recentActivity: recentLogs ?? [],
      };
    }),

  /**
   * Update user status (active/disabled/banned)
   */
  updateUserStatus: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      status: z.enum(['active', 'disabled', 'banned']),
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current status
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('status, nickname, email')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const previousStatus = profile.status;

      // Update status
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ status: input.status })
        .eq('id', input.userId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Log the activity
      await ctx.supabase.from('user_activity_logs').insert({
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `账号状态变更: ${previousStatus} → ${input.status}`,
        action_type: 'status_change',
        details: {
          previousStatus,
          newStatus: input.status,
          reason: input.reason,
        },
      });

      return data;
    }),

  /**
   * Update user membership level
   */
  updateUserMembership: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      membershipLevel: z.enum(['free', 'pro', 'gold']),
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current membership
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('membership_level, nickname, email')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const previousLevel = profile.membership_level;
      const overrideTimestamp = new Date().toISOString();

      // Update membership level
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ membership_level: input.membershipLevel })
        .eq('id', input.userId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      const { data: latestSubscription } = await ctx.supabase
        .from('user_subscriptions')
        .select('id, metadata, stripe_subscription_id, status')
        .eq('user_id', input.userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (
        input.membershipLevel !== previousLevel &&
        latestSubscription &&
        isStripeManagedSubscriptionActive({
          stripeSubscriptionId: latestSubscription.stripe_subscription_id,
          status: latestSubscription.status,
        })
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: getAdminMembershipOverrideErrorMessage(),
        });
      }

      if (latestSubscription?.id) {
        let targetPlanId: string | null = null;

        if (input.membershipLevel !== 'free') {
          const { data: targetPlan, error: targetPlanError } = await ctx.supabase
            .from('membership_plans')
            .select('id')
            .eq('level', input.membershipLevel)
            .eq('is_active', 'true')
            .order('sort_order', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (targetPlanError) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: targetPlanError.message });
          }

          targetPlanId = targetPlan?.id ?? null;
        }

        const metadata = latestSubscription.metadata && typeof latestSubscription.metadata === 'object'
          ? latestSubscription.metadata
          : {};

        const { error: subscriptionSyncError } = await ctx.supabase
          .from('user_subscriptions')
          .update({
            membership_plan_id: targetPlanId,
            status: 'admin_override',
            updated_at: overrideTimestamp,
            metadata: {
              ...metadata,
              adminOverride: {
                adminId: ctx.profileId,
                overriddenAt: overrideTimestamp,
                previousLevel,
                newLevel: input.membershipLevel,
                reason: input.reason ?? null,
              },
            },
          })
          .eq('id', latestSubscription.id);

        if (subscriptionSyncError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: subscriptionSyncError.message });
        }
      }

      // Log the activity
      await ctx.supabase.from('user_activity_logs').insert({
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `会员等级变更: ${previousLevel} → ${input.membershipLevel}`,
        action_type: 'membership_change',
        details: {
          previousLevel,
          newLevel: input.membershipLevel,
          reason: input.reason,
        },
      });

      return data;
    }),

  /**
   * Get user activity logs
   */
  getUserActivityLogs: adminProcedure
    .input(z.object({
      userId: z.string().uuid().optional(),
      actionType: z.enum(['status_change', 'role_change', 'membership_change', 'credit_adjustment', 'system']).optional(),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('user_activity_logs')
        .select(`
          *,
          user:profiles!user_activity_logs_user_id_fkey(id, email, nickname, avatar_url),
          admin:profiles!user_activity_logs_admin_id_fkey(id, email, nickname, avatar_url)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.userId) {
        query = query.eq('user_id', input.userId);
      }

      if (input.actionType) {
        query = query.eq('action_type', input.actionType);
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return {
        logs: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
      };
    }),

  // ============================================
  // Credit Packages Management
  // ============================================

  /**
   * Get all credit packages
   */
  getAllPackages: adminProcedure
    .query(async ({ ctx }) => {
      const { data, error } = await ctx.supabase
        .from('credit_packages')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('price', { ascending: true });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data ?? [];
    }),

  /**
   * Create a new credit package
   */
  createPackage: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      price: z.number().int().positive(), // In cents
      creditsAmount: z.number().int().positive(),
      bonusCredits: z.number().int().min(0).default(0),
      stripePriceId: z.string().trim().min(1).max(255).optional(),
      sortOrder: z.number().int().min(0).default(0),
      isPopular: z.enum(['true', 'false']).default('false'),
      active: z.enum(['true', 'false']).default('true'),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('credit_packages')
        .insert({
          name: input.name,
          price: input.price,
          credits_amount: input.creditsAmount,
          bonus_credits: input.bonusCredits,
          stripe_price_id: input.stripePriceId ?? null,
          sort_order: input.sortOrder,
          is_popular: input.isPopular,
          active: input.active,
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update a credit package
   */
  updatePackage: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      price: z.number().int().positive().optional(),
      creditsAmount: z.number().int().positive().optional(),
      bonusCredits: z.number().int().min(0).optional(),
      stripePriceId: z.string().trim().min(1).max(255).nullable().optional(),
      sortOrder: z.number().int().min(0).optional(),
      isPopular: z.enum(['true', 'false']).optional(),
      active: z.enum(['true', 'false']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {};
      if (input.name) updateData.name = input.name;
      if (input.price) updateData.price = input.price;
      if (input.creditsAmount) updateData.credits_amount = input.creditsAmount;
      if (input.bonusCredits !== undefined) updateData.bonus_credits = input.bonusCredits;
      if (input.stripePriceId !== undefined) updateData.stripe_price_id = input.stripePriceId || null;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;
      if (input.isPopular) updateData.is_popular = input.isPopular;
      if (input.active) updateData.active = input.active;

      const { data, error } = await ctx.supabase
        .from('credit_packages')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Delete a credit package
   */
  deletePackage: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('credit_packages')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  // ============================================
  // Announcements Management
  // ============================================

  /**
   * Get all announcements (for admin)
   */
  getAllAnnouncements: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('announcements')
        .select('*', { count: 'exact' })
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.activeOnly) {
        query = query.eq('active', 'true');
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Get stats
      const statsQuery = await ctx.supabase
        .from('announcements')
        .select('active, type');

      const stats = {
        total: statsQuery.data?.length ?? 0,
        active: statsQuery.data?.filter(a => a.active === 'true').length ?? 0,
        inactive: statsQuery.data?.filter(a => a.active === 'false').length ?? 0,
        byType: {
          info: statsQuery.data?.filter(a => a.type === 'info').length ?? 0,
          warning: statsQuery.data?.filter(a => a.type === 'warning').length ?? 0,
          success: statsQuery.data?.filter(a => a.type === 'success').length ?? 0,
          error: statsQuery.data?.filter(a => a.type === 'error').length ?? 0,
        },
      };

      return {
        announcements: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
    }),

  /**
   * Create a new announcement
   */
  createAnnouncement: adminProcedure
    .input(z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(5000),
      type: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).default('info'),
      announcementType: z.enum(['homepage', 'banner']).default('homepage'),
      bannerStyle: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).optional(),
      bannerLink: z.string().optional(),
      icon: z.string().default('Megaphone'),
      iconColor: z.string().default('text-blue-500'),
      tag: z.string().optional(),
      tagColor: z.string().default('blue'),
      priority: z.number().int().min(0).max(100).default(0),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('announcements')
        .insert({
          title: input.title,
          content: input.content,
          type: input.type,
          announcement_type: input.announcementType,
          banner_style: input.bannerStyle ?? input.type,
          banner_link: input.bannerLink,
          icon: input.icon,
          icon_color: input.iconColor,
          tag: input.tag,
          tag_color: input.tagColor,
          priority: input.priority,
          active: 'true',
          start_date: input.startDate ?? new Date().toISOString(),
          end_date: input.endDate ?? null,
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update an announcement
   */
  updateAnnouncement: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(5000).optional(),
      type: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).optional(),
      announcementType: z.enum(['homepage', 'banner']).optional(),
      bannerStyle: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).optional(),
      bannerLink: z.string().optional(),
      icon: z.string().optional(),
      iconColor: z.string().optional(),
      tag: z.string().optional(),
      tagColor: z.string().optional(),
      priority: z.number().int().min(0).max(100).optional(),
      active: z.enum(['true', 'false']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.title !== undefined) updateData.title = input.title;
      if (input.content !== undefined) updateData.content = input.content;
      if (input.type !== undefined) updateData.type = input.type;
      if (input.announcementType !== undefined) updateData.announcement_type = input.announcementType;
      if (input.bannerStyle !== undefined) updateData.banner_style = input.bannerStyle;
      if (input.bannerLink !== undefined) updateData.banner_link = input.bannerLink;
      if (input.icon !== undefined) updateData.icon = input.icon;
      if (input.iconColor !== undefined) updateData.icon_color = input.iconColor;
      if (input.tag !== undefined) updateData.tag = input.tag;
      if (input.tagColor !== undefined) updateData.tag_color = input.tagColor;
      if (input.priority !== undefined) updateData.priority = input.priority;
      if (input.active !== undefined) updateData.active = input.active;
      if (input.startDate !== undefined) updateData.start_date = input.startDate;
      if (input.endDate !== undefined) updateData.end_date = input.endDate;

      const { data, error } = await ctx.supabase
        .from('announcements')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Delete an announcement
   */
  deleteAnnouncement: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('announcements')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  /**
   * Get active announcements (public, but could be used by admin preview too)
   */
  getActiveAnnouncements: adminProcedure
    .query(async ({ ctx }) => {
      const now = new Date().toISOString();

      const { data, error } = await ctx.supabase
        .from('announcements')
        .select('*')
        .eq('active', 'true')
        .lte('start_date', now)
        .or(`end_date.is.null,end_date.gt.${now}`)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data ?? [];
    }),

  // ============================================
  // Prompts Management
  // ============================================

  /**
   * Get all prompts (for admin)
   */
  getAllPrompts: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      category: promptCategorySchema.optional(),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('prompts')
        .select('*', { count: 'exact' })
        .order('sort_order', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.category) {
        query = query.eq('category', input.category);
      }

      if (input.activeOnly) {
        query = query.eq('active', 'true');
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Get stats
      const statsQuery = await ctx.supabase
        .from('prompts')
        .select('active, category, is_system');

      const stats = {
        total: statsQuery.data?.length ?? 0,
        active: statsQuery.data?.filter(p => p.active === 'true').length ?? 0,
        inactive: statsQuery.data?.filter(p => p.active === 'false').length ?? 0,
        system: statsQuery.data?.filter(p => p.is_system === 'true').length ?? 0,
        byCategory: {
          general: statsQuery.data?.filter(p => p.category === 'general').length ?? 0,
          assistant: statsQuery.data?.filter(p => p.category === 'assistant').length ?? 0,
          creative: statsQuery.data?.filter(p => p.category === 'creative').length ?? 0,
          coding: statsQuery.data?.filter(p => p.category === 'coding').length ?? 0,
          translation: statsQuery.data?.filter(p => p.category === 'translation').length ?? 0,
          analysis: statsQuery.data?.filter(p => p.category === 'analysis').length ?? 0,
        },
      };

      return {
        prompts: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
    }),

  /**
   * Create a new prompt
   */
  createPrompt: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      content: z.string().min(1).max(10000),
      // New fields
      systemPrompt: z.string().max(10000).optional(),
      userPromptTemplate: z.string().max(10000).optional(),
      modelId: z.string().uuid().optional(),
      platform: promptPlatformSchema.default('all'),
      features: z.array(z.string()).optional(),
      userQuestions: z.array(z.string()).optional(),
      icon: z.string().max(50).default('Wand2'),
      // Original fields
      category: promptCategorySchema.default('general'),
      sortOrder: z.number().int().min(0).max(1000).default(0),
      isSystem: z.enum(['true', 'false']).default('false'),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('prompts')
        .insert({
          name: input.name,
          description: input.description ?? null,
          content: input.content,
          system_prompt: input.systemPrompt ?? null,
          user_prompt_template: input.userPromptTemplate ?? null,
          model_id: input.modelId ?? null,
          platform: input.platform,
          features: input.features ? JSON.stringify(input.features) : null,
          user_questions: input.userQuestions ? JSON.stringify(input.userQuestions) : null,
          icon: input.icon,
          category: input.category,
          sort_order: input.sortOrder,
          is_system: input.isSystem,
          active: 'true',
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update a prompt
   */
  updatePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(500).nullable().optional(),
      content: z.string().min(1).max(10000).optional(),
      // New fields
      systemPrompt: z.string().max(10000).nullable().optional(),
      userPromptTemplate: z.string().max(10000).nullable().optional(),
      modelId: z.string().uuid().nullable().optional(),
      platform: promptPlatformSchema.optional(),
      features: z.array(z.string()).nullable().optional(),
      userQuestions: z.array(z.string()).nullable().optional(),
      icon: z.string().max(50).optional(),
      // Original fields
      category: promptCategorySchema.optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      active: z.enum(['true', 'false']).optional(),
      isSystem: z.enum(['true', 'false']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.content !== undefined) updateData.content = input.content;
      if (input.systemPrompt !== undefined) updateData.system_prompt = input.systemPrompt;
      if (input.userPromptTemplate !== undefined) updateData.user_prompt_template = input.userPromptTemplate;
      if (input.modelId !== undefined) updateData.model_id = input.modelId;
      if (input.platform !== undefined) updateData.platform = input.platform;
      if (input.features !== undefined) updateData.features = input.features ? JSON.stringify(input.features) : null;
      if (input.userQuestions !== undefined) updateData.user_questions = input.userQuestions ? JSON.stringify(input.userQuestions) : null;
      if (input.icon !== undefined) updateData.icon = input.icon;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;
      if (input.active !== undefined) updateData.active = input.active;
      if (input.isSystem !== undefined) updateData.is_system = input.isSystem;

      const { data, error } = await ctx.supabase
        .from('prompts')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  batchUpdatePrompts: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      patch: promptBatchPatchSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (input.patch.description !== undefined) updateData.description = input.patch.description;
      if (input.patch.systemPrompt !== undefined) updateData.system_prompt = input.patch.systemPrompt;
      if (input.patch.userPromptTemplate !== undefined) updateData.user_prompt_template = input.patch.userPromptTemplate;
      if (input.patch.modelId !== undefined) updateData.model_id = input.patch.modelId;
      if (input.patch.platform !== undefined) updateData.platform = input.patch.platform;
      if (input.patch.features !== undefined) updateData.features = input.patch.features ? JSON.stringify(input.patch.features) : null;
      if (input.patch.userQuestions !== undefined) updateData.user_questions = input.patch.userQuestions ? JSON.stringify(input.patch.userQuestions) : null;
      if (input.patch.icon !== undefined) updateData.icon = input.patch.icon;
      if (input.patch.category !== undefined) updateData.category = input.patch.category;
      if (input.patch.sortOrder !== undefined) updateData.sort_order = input.patch.sortOrder;

      const { data, error } = await ctx.supabase
        .from('prompts')
        .update(updateData)
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return {
        updatedIds: (data ?? []).map((prompt) => prompt.id),
        updatedCount: data?.length ?? 0,
      };
    }),

  batchSetPromptActive: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      active: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('prompts')
        .update({
          active: input.active ? 'true' : 'false',
          updated_at: new Date().toISOString(),
        })
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return {
        updatedIds: (data ?? []).map((prompt) => prompt.id),
        updatedCount: data?.length ?? 0,
        active: input.active,
      };
    }),

  batchDeletePrompts: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data: prompts, error: promptError } = await ctx.supabase
        .from('prompts')
        .select('id, is_system')
        .in('id', input.ids);

      if (promptError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: promptError.message });
      }

      const deletableIds = (prompts ?? [])
        .filter((prompt) => prompt.is_system !== 'true')
        .map((prompt) => prompt.id);
      const blockedIds = (prompts ?? [])
        .filter((prompt) => prompt.is_system === 'true')
        .map((prompt) => prompt.id);

      if (deletableIds.length > 0) {
        const { error } = await ctx.supabase
          .from('prompts')
          .delete()
          .in('id', deletableIds);

        if (error) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
        }
      }

      return {
        deletedIds: deletableIds,
        deletedCount: deletableIds.length,
        blockedIds,
        blockedCount: blockedIds.length,
      };
    }),

  /**
   * Delete a prompt
   */
  deletePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Check if it's a system prompt
      const { data: prompt } = await ctx.supabase
        .from('prompts')
        .select('is_system')
        .eq('id', input.id)
        .single();

      if (prompt?.is_system === 'true') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot delete system prompts' });
      }

      const { error } = await ctx.supabase
        .from('prompts')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  // ============================================
  // Finance Statistics
  // ============================================

  /**
   * Get financial statistics
   */
  getFinanceStats: adminProcedure
    .query(async ({ ctx }) => {
      const { data: creditTransactions } = await ctx.supabase
        .from('credit_transactions')
        .select('amount, type, created_at, description')
        .order('created_at', { ascending: false });

      const { data: packages } = await ctx.supabase
        .from('credit_packages')
        .select('*');

      const { data: users } = await ctx.supabase
        .from('profiles')
        .select('credits, created_at');

      const { data: models } = await ctx.supabase
        .from('ai_models')
        .select('*')
        .order('name', { ascending: true });

      const { data: conversations } = await ctx.supabase
        .from('conversations')
        .select('id, model_id, created_at');

      const { data: tokenStats } = await ctx.supabase
        .from('token_stats')
        .select('model_used, total_credits, total_cost_usd, cached_tokens, created_at');

      const { data: paymentOrders } = await ctx.supabase
        .from('payment_orders')
        .select('amount_total, currency, status, payment_status, created_at');

      const { data: usageLogs } = await ctx.supabase
        .from('ai_usage_logs')
        .select('status, created_at');

      const { data: billingHistory } = await ctx.supabase
        .from('billing_history')
        .select('operation_type, amount, created_at, metadata');

      const { data: settings } = await ctx.supabase
        .from('system_settings')
        .select('*')
        .in('key', [
          'input_credits_per_1k',
          'output_credits_per_1k',
          'web_search_credits',
          'new_user_credits',
        ]);

      // Calculate overall stats
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const transactionStats = {
        totalAdditions: 0,
        totalDeductions: 0,
        totalPurchases: 0,
        totalRefunds: 0,
        todayTransactions: 0,
        weekTransactions: 0,
        monthTransactions: 0,
      };

      // Daily breakdown for chart (last 30 days)
      const dailyStats: Record<string, { additions: number; deductions: number; purchases: number }> = {};
      for (let i = 0; i < 30; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        dailyStats[dateKey] = { additions: 0, deductions: 0, purchases: 0 };
      }

      creditTransactions?.forEach(t => {
        const transDate = new Date(t.created_at);
        const dateKey = transDate.toISOString().split('T')[0];

        if (t.type === 'addition') {
          transactionStats.totalAdditions += t.amount;
          if (dailyStats[dateKey]) dailyStats[dateKey].additions += t.amount;
        } else if (t.type === 'purchase') {
          transactionStats.totalPurchases += t.amount;
          if (dailyStats[dateKey]) dailyStats[dateKey].purchases += t.amount;
        }

        if (transDate >= todayStart) transactionStats.todayTransactions++;
        if (transDate >= sevenDaysAgo) transactionStats.weekTransactions++;
        if (transDate >= thirtyDaysAgo) transactionStats.monthTransactions++;
      });

      tokenStats?.forEach((stat) => {
        const createdAt = new Date(stat.created_at);
        const dateKey = createdAt.toISOString().split('T')[0];
        const credits = stat.total_credits ?? 0;

        transactionStats.totalDeductions += credits;
        if (dailyStats[dateKey]) {
          dailyStats[dateKey].deductions += credits;
        }
      });

      billingHistory?.forEach((entry) => {
        const createdAt = new Date(entry.created_at);
        if (createdAt >= todayStart) transactionStats.todayTransactions++;
        if (createdAt >= sevenDaysAgo) transactionStats.weekTransactions++;
        if (createdAt >= thirtyDaysAgo) transactionStats.monthTransactions++;

        if (entry.operation_type === 'refund') {
          transactionStats.totalRefunds += Math.abs(entry.amount ?? 0);
        }
      });

      // User statistics
      const userStats = {
        totalUsers: users?.length ?? 0,
        totalCreditsInSystem: users?.reduce((sum, u) => sum + (u.credits ?? 0), 0) ?? 0,
        averageCreditsPerUser: 0,
        newUsersThisMonth: 0,
        newUsersThisWeek: 0,
      };

      users?.forEach(u => {
        const createdAt = new Date(u.created_at);
        if (createdAt >= thirtyDaysAgo) userStats.newUsersThisMonth++;
        if (createdAt >= sevenDaysAgo) userStats.newUsersThisWeek++;
      });

      if (userStats.totalUsers > 0) {
        userStats.averageCreditsPerUser = Math.round(userStats.totalCreditsInSystem / userStats.totalUsers);
      }

      // Package statistics
      const packageStats = {
        totalPackages: packages?.length ?? 0,
        activePackages: packages?.filter(p => p.active === 'true').length ?? 0,
        packages: packages?.map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          creditsAmount: p.credits_amount,
          active: p.active,
        })) ?? [],
      };

      // Convert daily stats to array for charting
      const dailyChartData = Object.entries(dailyStats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          ...data,
        }));

      // API/Model statistics
      const apiStats = {
        totalRequests: usageLogs?.length ?? tokenStats?.length ?? 0,
        totalConversations: conversations?.length ?? 0,
        messagesThisMonth: usageLogs?.filter(log => new Date(log.created_at) >= thirtyDaysAgo).length ?? 0,
        messagesThisWeek: usageLogs?.filter(log => new Date(log.created_at) >= sevenDaysAgo).length ?? 0,
      };

      // Model statistics with usage count
      const modelUsageByConversation: Record<string, number> = {};
      conversations?.forEach((conv) => {
        if (conv.model_id) {
          modelUsageByConversation[conv.model_id] = (modelUsageByConversation[conv.model_id] || 0) + 1;
        }
      });

      const modelUsageByToken: Record<string, { requests: number; credits: number; costUsd: number }> = {};
      tokenStats?.forEach((stat) => {
        const key = stat.model_used;
        if (!key) return;
        const current = modelUsageByToken[key] ?? { requests: 0, credits: 0, costUsd: 0 };
        current.requests += 1;
        current.credits += stat.total_credits ?? 0;
        current.costUsd += parseFloat(stat.total_cost_usd ?? '0');
        modelUsageByToken[key] = current;
      });

      const modelStats = models?.map(model => ({
        id: model.id,
        name: model.name,
        modelId: model.model_id,
        provider: model.provider,
        isActive: model.is_active,
        inputTokenCost: model.input_token_cost,
        outputTokenCost: model.output_token_cost,
        inputTokenCostAbove200k: model.input_token_cost_above_200k,
        outputTokenCostAbove200k: model.output_token_cost_above_200k,
        webSearchCost: model.web_search_cost,
        maxTokens: model.max_tokens,
        conversationCount: modelUsageByConversation[model.id] || 0,
        requestCount: modelUsageByToken[model.model_id]?.requests || 0,
        creditsConsumed: modelUsageByToken[model.model_id]?.credits || 0,
        costUsd: parseFloat((modelUsageByToken[model.model_id]?.costUsd || 0).toFixed(6)),
      })) ?? [];

      const actualRevenue = paymentOrders?.reduce((sum, order) => {
        if (order.status !== 'completed') return sum;
        if (order.payment_status !== 'paid' && order.payment_status !== 'no_payment_required') return sum;
        if (order.currency && order.currency.toLowerCase() !== 'usd') return sum;
        return sum + (order.amount_total ?? 0);
      }, 0) ?? 0;

      const financeOverview = {
        estimatedRevenue: actualRevenue,
        creditsConsumed: transactionStats.totalDeductions,
        creditsPurchased: transactionStats.totalPurchases,
        creditsGiven: transactionStats.totalAdditions,
        netCreditsFlow: transactionStats.totalAdditions + transactionStats.totalPurchases - transactionStats.totalDeductions,
      };

      // Credits conversion rules from settings
      const settingsMap: Record<string, unknown> = {};
      settings?.forEach(s => {
        settingsMap[s.key] = s.value;
      });

      const creditsRules = {
        inputCreditsPerK: settingsMap['input_credits_per_1k'] ?? 1,
        outputCreditsPerK: settingsMap['output_credits_per_1k'] ?? 3,
        webSearchCredits: settingsMap['web_search_credits'] ?? 5,
        newUserCredits: settingsMap['new_user_credits'] ?? 100,
      };

      return {
        transactions: transactionStats,
        users: userStats,
        packages: packageStats,
        dailyChart: dailyChartData,
        apiStats,
        modelStats,
        financeOverview,
        creditsRules,
      };
    }),

  // ============================================
  // Performance Monitoring
  // ============================================

// ============================================
  // Membership Plans Management
  // ============================================

  /**
   * Get all membership plans
   */
  getAllMembershipPlans: adminProcedure
    .query(async ({ ctx }) => {
      const { data, error } = await ctx.supabase
        .from('membership_plans')
        .select('*')
        .order('sort_order', { ascending: true });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data ?? [];
    }),

  /**
   * Create a new membership plan
   */
  createMembershipPlan: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      level: z.enum(['free', 'pro', 'gold']).default('pro'),
      monthlyPrice: z.number().int().min(0), // In cents
      yearlyPrice: z.number().int().min(0), // In cents
      stripeMonthlyPriceId: z.string().trim().min(1).max(255).optional(),
      stripeYearlyPriceId: z.string().trim().min(1).max(255).optional(),
      monthlyCredits: z.number().int().min(0),
      yearlyCredits: z.number().int().min(0),
      monthlyBonusCredits: z.number().int().min(0).default(0),
      packageDiscount: z.number().int().min(0).max(100).default(100),
      features: z.array(z.string()).default([]),
      maxContextMessages: z.number().int().min(5).max(100).default(20), // 上下文消息数限制
      sortOrder: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('membership_plans')
        .insert({
          name: input.name,
          level: input.level,
          monthly_price: input.monthlyPrice,
          yearly_price: input.yearlyPrice,
          stripe_monthly_price_id: input.stripeMonthlyPriceId ?? null,
          stripe_yearly_price_id: input.stripeYearlyPriceId ?? null,
          monthly_credits: input.monthlyCredits,
          yearly_credits: input.yearlyCredits,
          monthly_bonus_credits: input.monthlyBonusCredits,
          package_discount: input.packageDiscount,
          features: input.features,
          max_context_messages: input.maxContextMessages,
          is_active: 'true',
          sort_order: input.sortOrder,
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update a membership plan
   */
  updateMembershipPlan: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      level: z.enum(['free', 'pro', 'gold']).optional(),
      monthlyPrice: z.number().int().min(0).optional(),
      yearlyPrice: z.number().int().min(0).optional(),
      stripeMonthlyPriceId: z.string().trim().min(1).max(255).nullable().optional(),
      stripeYearlyPriceId: z.string().trim().min(1).max(255).nullable().optional(),
      monthlyCredits: z.number().int().min(0).optional(),
      yearlyCredits: z.number().int().min(0).optional(),
      monthlyBonusCredits: z.number().int().min(0).optional(),
      packageDiscount: z.number().int().min(0).max(100).optional(),
      features: z.array(z.string()).optional(),
      historyRetentionDays: z.number().int().min(1).max(365).optional(),
      maxContextMessages: z.number().int().min(5).max(100).optional(), // 上下文消息数限制
      allowExport: z.enum(['true', 'false']).optional(),
      allowBatchExport: z.enum(['true', 'false']).optional(),
      isActive: z.enum(['true', 'false']).optional(),
      sortOrder: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.level !== undefined) updateData.level = input.level;
      if (input.monthlyPrice !== undefined) updateData.monthly_price = input.monthlyPrice;
      if (input.yearlyPrice !== undefined) updateData.yearly_price = input.yearlyPrice;
      if (input.stripeMonthlyPriceId !== undefined) updateData.stripe_monthly_price_id = input.stripeMonthlyPriceId || null;
      if (input.stripeYearlyPriceId !== undefined) updateData.stripe_yearly_price_id = input.stripeYearlyPriceId || null;
      if (input.monthlyCredits !== undefined) updateData.monthly_credits = input.monthlyCredits;
      if (input.yearlyCredits !== undefined) updateData.yearly_credits = input.yearlyCredits;
      if (input.monthlyBonusCredits !== undefined) updateData.monthly_bonus_credits = input.monthlyBonusCredits;
      if (input.packageDiscount !== undefined) updateData.package_discount = input.packageDiscount;
      if (input.features !== undefined) updateData.features = input.features;
      if (input.historyRetentionDays !== undefined) updateData.history_retention_days = input.historyRetentionDays;
      if (input.maxContextMessages !== undefined) updateData.max_context_messages = input.maxContextMessages;
      if (input.allowExport !== undefined) updateData.allow_export = input.allowExport;
      if (input.allowBatchExport !== undefined) updateData.allow_batch_export = input.allowBatchExport;
      if (input.isActive !== undefined) updateData.is_active = input.isActive;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;

      const { data, error } = await ctx.supabase
        .from('membership_plans')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Delete a membership plan
   */
  deleteMembershipPlan: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('membership_plans')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  /**
   * Clean up expired conversations based on membership retention settings
   */
  cleanupExpiredConversations: adminProcedure
    .mutation(async ({ ctx }) => {
      const runId = await startScheduledJobRun({
        supabase: ctx.supabase,
        jobKey: SCHEDULED_JOB_KEYS.conversationCleanup,
        triggerSource: 'manual',
      });

      try {
        const service = new ConversationCleanupService({ supabase: ctx.supabase });
        const result = await service.run();

        await finishScheduledJobRun({
          supabase: ctx.supabase,
          runId,
          status: 'success',
          summary: {
            deletedCount: result.deletedCount,
            stats: result.stats,
          },
        });

        return {
          success: true,
          deletedCount: result.deletedCount,
          stats: result.stats,
          message: `清理完成，已删除 ${result.deletedCount} 个过期对话`,
        };
      } catch (error) {
        await finishScheduledJobRun({
          supabase: ctx.supabase,
          runId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown cleanup error',
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : '对话清理失败',
        });
      }
    }),

  /**
   * Get conversation cleanup statistics
   */
  getCleanupStats: adminProcedure
    .query(async ({ ctx }) => {
      const service = new ConversationCleanupService({ supabase: ctx.supabase });
      const [{ stats, totalExpired }, latestRun] = await Promise.all([
        service.getCleanupStats(),
        getLatestScheduledJobRun(ctx.supabase, SCHEDULED_JOB_KEYS.conversationCleanup),
      ]);

      return {
        stats,
        totalExpired,
        latestRun,
      };
    }),

  // ============================================
  // Performance Monitoring
  // ============================================

  /**
   * Get performance statistics with AI performance metrics
   */
  getPerformanceStats: adminProcedure
    .input(z.object({
      timeRange: z.enum(['7d', '14d', '30d']).default('14d'),
    }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const daysMap = { '7d': 7, '14d': 14, '30d': 30 };
      const days = daysMap[input.timeRange];
      const rangeStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [
        conversationTotalResult,
        conversationTodayResult,
        conversationWeekResult,
        conversationMonthResult,
        conversationsInRangeResult,
        messageTotalResult,
        messageUserResult,
        messageAssistantResult,
        messageTodayResult,
        messageWeekResult,
        messageMonthResult,
        messagesInRangeResult,
        ticketTotalResult,
        ticketOpenResult,
        ticketInProgressResult,
        ticketClosedResult,
        modelsResult,
        allTokenStatsResult,
        usageLogsResult,
        conversationsForModelUsageResult,
      ] = await Promise.all([
        ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }),
        ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
        ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo.toISOString()),
        ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo.toISOString()),
        ctx.supabase
          .from('conversations')
          .select('model_id, created_at')
          .gte('created_at', rangeStart.toISOString()),
        ctx.supabase.from('messages').select('id', { count: 'exact', head: true }),
        ctx.supabase.from('messages').select('id', { count: 'exact', head: true }).eq('role', 'user'),
        ctx.supabase.from('messages').select('id', { count: 'exact', head: true }).eq('role', 'assistant'),
        ctx.supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
        ctx.supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo.toISOString()),
        ctx.supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo.toISOString()),
        ctx.supabase
          .from('messages')
          .select('role, created_at')
          .gte('created_at', rangeStart.toISOString()),
        ctx.supabase.from('tickets').select('id', { count: 'exact', head: true }),
        ctx.supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        ctx.supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'in_progress'),
        ctx.supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'closed'),
        ctx.supabase
          .from('ai_models')
          .select('id, name, model_id, provider, input_token_cost, output_token_cost, web_search_cost, is_active'),
        ctx.supabase
          .from('token_stats')
          .select('model_used, total_credits, total_cost_usd, input_tokens, output_tokens, cached_tokens, cache_creation_tokens, created_at')
          .gte('created_at', rangeStart.toISOString()),
        ctx.supabase
          .from('ai_usage_logs')
          .select('status, latency_ms, created_at')
          .gte('created_at', rangeStart.toISOString()),
        ctx.supabase
          .from('conversations')
          .select('id, model_id, created_at')
          .gte('created_at', rangeStart.toISOString()),
      ]);

      const results = [
        conversationTotalResult,
        conversationTodayResult,
        conversationWeekResult,
        conversationMonthResult,
        conversationsInRangeResult,
        messageTotalResult,
        messageUserResult,
        messageAssistantResult,
        messageTodayResult,
        messageWeekResult,
        messageMonthResult,
        messagesInRangeResult,
        ticketTotalResult,
        ticketOpenResult,
        ticketInProgressResult,
        ticketClosedResult,
        modelsResult,
        allTokenStatsResult,
        usageLogsResult,
        conversationsForModelUsageResult,
      ];

      for (const result of results) {
        if (result.error) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
        }
      }

      const conversationsInRange = conversationsInRangeResult.data ?? [];
      const messagesInRange = messagesInRangeResult.data ?? [];
      const models = modelsResult.data ?? [];
      const tokenStatsInRange = allTokenStatsResult.data ?? [];
      const usageLogs = usageLogsResult.data ?? [];
      const conversationsForModelUsage = conversationsForModelUsageResult.data ?? [];

      const conversationStats = {
        total: conversationTotalResult.count ?? 0,
        today: conversationTodayResult.count ?? 0,
        thisWeek: conversationWeekResult.count ?? 0,
        thisMonth: conversationMonthResult.count ?? 0,
        inRange: conversationsInRangeResult.count ?? 0,
      };

      const messageStats = {
        total: messageTotalResult.count ?? 0,
        userMessages: messageUserResult.count ?? 0,
        assistantMessages: messageAssistantResult.count ?? 0,
        today: messageTodayResult.count ?? 0,
        thisWeek: messageWeekResult.count ?? 0,
        thisMonth: messageMonthResult.count ?? 0,
        inRange: messagesInRangeResult.count ?? 0,
      };

      const ticketStats = {
        total: ticketTotalResult.count ?? 0,
        open: ticketOpenResult.count ?? 0,
        inProgress: ticketInProgressResult.count ?? 0,
        closed: ticketClosedResult.count ?? 0,
      };

      const modelUsageByToken = new Map<string, {
        requestCount: number;
        credits: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
      }>();

      for (const stat of tokenStatsInRange) {
        const current = modelUsageByToken.get(stat.model_used) ?? {
          requestCount: 0,
          credits: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        };
        current.requestCount += 1;
        current.credits += stat.total_credits ?? 0;
        current.costUsd += parseFloat(stat.total_cost_usd ?? '0');
        current.inputTokens += stat.input_tokens ?? 0;
        current.outputTokens += stat.output_tokens ?? 0;
        current.cachedTokens += stat.cached_tokens ?? 0;
        modelUsageByToken.set(stat.model_used, current);
      }

      const conversationsByModel = new Map<string, number>();
      for (const conversation of conversationsForModelUsage) {
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
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        };

        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          isActive: model.is_active,
          conversationCount: conversationsByModel.get(model.id) ?? 0,
          requestCount: usage.requestCount,
          creditsConsumed: usage.credits,
          totalCostUsd: parseFloat(usage.costUsd.toFixed(6)),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          inputTokenCost: model.input_token_cost ?? 0,
          outputTokenCost: model.output_token_cost ?? 0,
          webSearchCost: model.web_search_cost ?? 0,
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

      const averages = {
        messagesPerConversation: conversationStats.total > 0
          ? Math.round(messageStats.total / conversationStats.total)
          : 0,
        conversationsPerDay: Math.round(conversationStats.inRange / days),
        messagesPerDay: Math.round(messageStats.inRange / days),
        requestsPerDay: Math.round(messagesInRange.filter((message) => message.role === 'assistant').length / days),
      };

      const totalRequests = messageAssistantResult.count ?? 0;
      const rangeRequests = messagesInRange.filter((message) => message.role === 'assistant').length;

      const inputTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.input_tokens ?? 0), 0);
      const outputTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.output_tokens ?? 0), 0);
      const cacheReadTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.cached_tokens ?? 0), 0);
      const cacheCreationTokens = tokenStatsInRange.reduce((sum, stat) => sum + (stat.cache_creation_tokens ?? 0), 0);

      const totalCost = tokenStatsInRange.reduce(
        (sum, stat) => sum + parseFloat(stat.total_cost_usd ?? '0'),
        0
      );
      const avgCostPerRequest = rangeRequests > 0 ? totalCost / rangeRequests : 0;
      const cacheSavings = tokenStatsInRange.reduce((sum, stat) => {
        const model = models.find((item) => item.model_id === stat.model_used);
        if (!model) return sum;
        return sum + (((stat.cached_tokens ?? 0) * (model.input_token_cost ?? 0) * 0.9) / 1000000000);
      }, 0);

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

      const totalInputWithoutCache = inputTokens + cacheReadTokens;
      const cacheHitRate = totalInputWithoutCache > 0
        ? (cacheReadTokens / totalInputWithoutCache) * 100
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
        cacheHitRate: parseFloat(cacheHitRate.toFixed(1)),
        healthStatus,
      };

      const tokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };

      const costStats = {
        totalCost: parseFloat(totalCost.toFixed(4)),
        avgCostPerRequest: parseFloat(avgCostPerRequest.toFixed(6)),
        cacheSavings: parseFloat(cacheSavings.toFixed(4)),
        estimatedMonthly: parseFloat((totalCost * (30 / days)).toFixed(2)),
      };

      return {
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
    }),
});
