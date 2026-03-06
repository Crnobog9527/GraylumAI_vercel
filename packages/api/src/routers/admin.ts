import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

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
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }),

      // Tickets by status
      ctx.supabase.from('tickets').select('status'),

      // Invitations by status
      ctx.supabase.from('invitations').select('status'),

      // Total credits in system
      ctx.supabase.from('profiles').select('credits'),

      // Recent users (last 10)
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, role, credits, created_at')
        .order('created_at', { ascending: false })
        .limit(10),

      // Users registered today
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),

      // Users registered this week
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),

      // Users registered this month
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),

      // Total conversations
      ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }),

      // Conversations today
      ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),

      // Conversations this week
      ctx.supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),

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
        .filter((t: { type: string }) => t.type === 'addition' || t.type === 'purchase')
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

      if (!ticketsData || ticketsData.length === 0) {
        return {
          tickets: [],
          total: count ?? 0,
          hasMore: false,
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
      const tickets = ticketsData.map(ticket => ({
        ...ticket,
        user: ticket.user_id ? usersMap.get(ticket.user_id) ?? null : null,
        ticket_replies: (repliesData ?? [])
          .filter(r => r.ticket_id === ticket.id)
          .map(reply => ({
            ...reply,
            user: reply.user_id ? replyUsersMap.get(reply.user_id) ?? null : null,
          })),
      }));

      return {
        tickets,
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
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
      type: z.enum(['deduction', 'addition', 'purchase', 'refund']).optional(),
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

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Calculate statistics
      const statsQuery = await ctx.supabase
        .from('credit_transactions')
        .select('type, amount');

      const stats = {
        totalAdditions: 0,
        totalDeductions: 0,
        totalPurchases: 0,
        totalRefunds: 0,
      };

      statsQuery.data?.forEach((t: { type: string; amount: number }) => {
        if (t.type === 'addition') stats.totalAdditions += t.amount;
        else if (t.type === 'deduction') stats.totalDeductions += Math.abs(t.amount);
        else if (t.type === 'purchase') stats.totalPurchases += t.amount;
        else if (t.type === 'refund') stats.totalRefunds += t.amount;
      });

      return {
        transactions: data ?? [],
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

      // Record transaction
      await ctx.supabase.from('credit_transactions').insert({
        user_id: input.userId,
        amount: input.amount,
        type: input.amount > 0 ? 'addition' : 'deduction',
        description: `[Admin] ${input.reason}`,
      });

      // Log the activity
      await ctx.supabase.from('user_activity_logs').insert({
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `积分调整: ${input.amount > 0 ? '+' : ''}${input.amount}`,
        action_type: 'credit_adjustment',
        details: {
          previousCredits: profile.credits,
          newCredits,
          adjustment: input.amount,
          reason: input.reason,
        },
      });

      return {
        previousCredits: profile.credits,
        newCredits,
        adjustment: input.amount,
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
      category: z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']).optional(),
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
      platform: z.enum(['all', 'web', 'mobile', 'desktop', 'api']).default('all'),
      features: z.array(z.string()).optional(),
      userQuestions: z.array(z.string()).optional(),
      icon: z.string().max(50).default('Wand2'),
      // Original fields
      category: z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']).default('general'),
      sortOrder: z.number().int().min(0).max(1000).default(0),
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
          is_system: 'false',
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
      platform: z.enum(['all', 'web', 'mobile', 'desktop', 'api']).optional(),
      features: z.array(z.string()).nullable().optional(),
      userQuestions: z.array(z.string()).nullable().optional(),
      icon: z.string().max(50).optional(),
      // Original fields
      category: z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']).optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      active: z.enum(['true', 'false']).optional(),
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
      // Get all transactions for analysis
      const { data: transactions } = await ctx.supabase
        .from('credit_transactions')
        .select('amount, type, created_at, description')
        .order('created_at', { ascending: false });

      // Get credit packages for revenue calculation
      const { data: packages } = await ctx.supabase
        .from('credit_packages')
        .select('*');

      // Get user statistics
      const { data: users } = await ctx.supabase
        .from('profiles')
        .select('credits, created_at');

      // Get AI models for cost configuration
      const { data: models } = await ctx.supabase
        .from('ai_models')
        .select('*')
        .order('name', { ascending: true });

      // Get messages for API request count estimate
      const { data: messages } = await ctx.supabase
        .from('messages')
        .select('id, role, created_at, conversation_id');

      // Get conversations with model info
      const { data: conversations } = await ctx.supabase
        .from('conversations')
        .select('id, model_id, created_at');

      // Get system settings for credits conversion rules
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

      transactions?.forEach(t => {
        const transDate = new Date(t.created_at);
        const dateKey = transDate.toISOString().split('T')[0];

        if (t.type === 'addition') transactionStats.totalAdditions += t.amount;
        else if (t.type === 'deduction') transactionStats.totalDeductions += Math.abs(t.amount);
        else if (t.type === 'purchase') transactionStats.totalPurchases += t.amount;
        else if (t.type === 'refund') transactionStats.totalRefunds += t.amount;

        if (transDate >= todayStart) transactionStats.todayTransactions++;
        if (transDate >= sevenDaysAgo) transactionStats.weekTransactions++;
        if (transDate >= thirtyDaysAgo) transactionStats.monthTransactions++;

        if (dailyStats[dateKey]) {
          if (t.type === 'addition') dailyStats[dateKey].additions += t.amount;
          else if (t.type === 'deduction') dailyStats[dateKey].deductions += Math.abs(t.amount);
          else if (t.type === 'purchase') dailyStats[dateKey].purchases += t.amount;
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
        totalRequests: messages?.filter(m => m.role === 'assistant').length ?? 0,
        totalConversations: conversations?.length ?? 0,
        messagesThisMonth: messages?.filter(m => new Date(m.created_at) >= thirtyDaysAgo).length ?? 0,
        messagesThisWeek: messages?.filter(m => new Date(m.created_at) >= sevenDaysAgo).length ?? 0,
      };

      // Model statistics with usage count
      const modelUsageMap: Record<string, number> = {};
      conversations?.forEach(conv => {
        if (conv.model_id) {
          modelUsageMap[conv.model_id] = (modelUsageMap[conv.model_id] || 0) + 1;
        }
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
        conversationCount: modelUsageMap[model.id] || 0,
      })) ?? [];

      // Revenue estimation from purchases (credits sold * estimated price)
      // Assume average credit package price for estimation
      const avgCreditPackagePrice = packages && packages.length > 0
        ? packages.reduce((sum, p) => sum + p.price, 0) / packages.length
        : 0;
      const avgCreditPackageAmount = packages && packages.length > 0
        ? packages.reduce((sum, p) => sum + p.credits_amount, 0) / packages.length
        : 1;
      const pricePerCredit = avgCreditPackageAmount > 0 ? avgCreditPackagePrice / avgCreditPackageAmount : 0;

      const financeOverview = {
        estimatedRevenue: Math.round(transactionStats.totalPurchases * pricePerCredit), // in cents
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
      // Get all membership plans with their retention settings
      const { data: plans, error: plansError } = await ctx.supabase
        .from('membership_plans')
        .select('level, history_retention_days');

      if (plansError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: plansError.message });
      }

      // Build retention map (default to 30 days if not set)
      const retentionMap: Record<string, number> = { free: 7, pro: 30, gold: 90 };
      plans?.forEach(plan => {
        if (plan.level && plan.history_retention_days) {
          retentionMap[plan.level] = plan.history_retention_days;
        }
      });

      // Get all users with their membership levels
      const { data: profiles, error: profilesError } = await ctx.supabase
        .from('profiles')
        .select('id, membership_level');

      if (profilesError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: profilesError.message });
      }

      let totalDeleted = 0;
      const now = new Date();

      // For each user, delete conversations older than their retention period
      for (const profile of profiles ?? []) {
        const membershipLevel = profile.membership_level || 'free';
        const retentionDays = retentionMap[membershipLevel] || 30;
        const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

        // Delete old conversations (messages will be cascade deleted)
        const { data, error } = await ctx.supabase
          .from('conversations')
          .delete()
          .eq('user_id', profile.id)
          .lt('created_at', cutoffDate.toISOString())
          .select('id');

        if (error) {
          console.error(`Failed to delete conversations for user ${profile.id}:`, error);
          continue;
        }

        totalDeleted += data?.length ?? 0;
      }

      return {
        success: true,
        deletedCount: totalDeleted,
        message: `清理完成，已删除 ${totalDeleted} 个过期对话`,
      };
    }),

  /**
   * Get conversation cleanup statistics
   */
  getCleanupStats: adminProcedure
    .query(async ({ ctx }) => {
      // Get membership plans
      const { data: plans } = await ctx.supabase
        .from('membership_plans')
        .select('level, history_retention_days');

      const retentionMap: Record<string, number> = { free: 7, pro: 30, gold: 90 };
      plans?.forEach(plan => {
        if (plan.level && plan.history_retention_days) {
          retentionMap[plan.level] = plan.history_retention_days;
        }
      });

      // Count conversations by membership level that would be deleted
      const now = new Date();
      const stats: { level: string; retentionDays: number; expiredCount: number }[] = [];

      for (const [level, days] of Object.entries(retentionMap)) {
        const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

        const { count } = await ctx.supabase
          .from('conversations')
          .select('id, profiles!inner(membership_level)', { count: 'exact', head: true })
          .eq('profiles.membership_level', level)
          .lt('created_at', cutoffDate.toISOString());

        stats.push({
          level,
          retentionDays: days,
          expiredCount: count ?? 0,
        });
      }

      const totalExpired = stats.reduce((sum, s) => sum + s.expiredCount, 0);

      return {
        stats,
        totalExpired,
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

      // Get conversations statistics
      const { data: conversations, count: totalConversations } = await ctx.supabase
        .from('conversations')
        .select('id, created_at, model_id', { count: 'exact' });

      // Get messages statistics with content for token estimation
      const { data: messages, count: totalMessages } = await ctx.supabase
        .from('messages')
        .select('id, role, created_at, content', { count: 'exact' });

      // Get AI models with pricing
      const { data: models } = await ctx.supabase
        .from('ai_models')
        .select('id, name, provider, input_token_cost, output_token_cost, web_search_cost, is_active');

      // Get tickets statistics
      const { data: tickets, count: totalTickets } = await ctx.supabase
        .from('tickets')
        .select('id, status, created_at', { count: 'exact' });

      // Filter by time range
      const rangeConversations = conversations?.filter(c => new Date(c.created_at) >= rangeStart) ?? [];
      const rangeMessages = messages?.filter(m => new Date(m.created_at) >= rangeStart) ?? [];

      // Calculate conversation stats
      const conversationStats = {
        total: totalConversations ?? 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        inRange: rangeConversations.length,
      };

      conversations?.forEach(c => {
        const createdAt = new Date(c.created_at);
        if (createdAt >= todayStart) conversationStats.today++;
        if (createdAt >= sevenDaysAgo) conversationStats.thisWeek++;
        if (createdAt >= thirtyDaysAgo) conversationStats.thisMonth++;
      });

      // Calculate message stats
      const messageStats = {
        total: totalMessages ?? 0,
        userMessages: messages?.filter(m => m.role === 'user').length ?? 0,
        assistantMessages: messages?.filter(m => m.role === 'assistant').length ?? 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        inRange: rangeMessages.length,
      };

      messages?.forEach(m => {
        const createdAt = new Date(m.created_at);
        if (createdAt >= todayStart) messageStats.today++;
        if (createdAt >= sevenDaysAgo) messageStats.thisWeek++;
        if (createdAt >= thirtyDaysAgo) messageStats.thisMonth++;
      });

      // Calculate ticket stats
      const ticketStats = {
        total: totalTickets ?? 0,
        open: tickets?.filter(t => t.status === 'open').length ?? 0,
        inProgress: tickets?.filter(t => t.status === 'in_progress').length ?? 0,
        closed: tickets?.filter(t => t.status === 'closed').length ?? 0,
      };

      // Model usage stats with cost estimation
      const modelUsage = models?.map(model => {
        const modelConversations = conversations?.filter(c => c.model_id === model.id) ?? [];
        const count = modelConversations.length;
        // Estimate tokens per message (avg ~150 tokens/message)
        const modelMessages = messages?.filter(m => {
          const conv = modelConversations.find(c => c.id === m.id);
          return !!conv;
        }) ?? [];
        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          isActive: model.is_active,
          conversationCount: count,
          inputTokenCost: model.input_token_cost ?? 0,
          outputTokenCost: model.output_token_cost ?? 0,
          webSearchCost: model.web_search_cost ?? 0,
        };
      }) ?? [];

      // Daily activity for the selected range
      const dailyActivity: Record<string, { conversations: number; messages: number; requests: number }> = {};
      for (let i = 0; i < days; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        dailyActivity[dateKey] = { conversations: 0, messages: 0, requests: 0 };
      }

      conversations?.forEach(c => {
        const dateKey = new Date(c.created_at).toISOString().split('T')[0];
        if (dailyActivity[dateKey]) {
          dailyActivity[dateKey].conversations++;
        }
      });

      messages?.forEach(m => {
        const dateKey = new Date(m.created_at).toISOString().split('T')[0];
        if (dailyActivity[dateKey]) {
          dailyActivity[dateKey].messages++;
          if (m.role === 'assistant') {
            dailyActivity[dateKey].requests++; // Each assistant message = 1 API request
          }
        }
      });

      const dailyChartData = Object.entries(dailyActivity)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          ...data,
        }));

      // Calculate averages
      const averages = {
        messagesPerConversation: conversationStats.total > 0
          ? Math.round(messageStats.total / conversationStats.total)
          : 0,
        conversationsPerDay: Math.round(conversationStats.inRange / days),
        messagesPerDay: Math.round(messageStats.inRange / days),
        requestsPerDay: Math.round(rangeMessages.filter(m => m.role === 'assistant').length / days),
      };

      // === AI Performance Statistics ===
      // Total API requests (assistant messages = API calls)
      const totalRequests = messages?.filter(m => m.role === 'assistant').length ?? 0;
      const rangeRequests = rangeMessages.filter(m => m.role === 'assistant').length;

      // === Real Token Usage from token_stats table ===
      // Get actual token statistics for the time range
      const { data: rangeTokenStats } = await ctx.supabase
        .from('token_stats')
        .select('input_tokens, output_tokens, cached_tokens, cache_creation_tokens')
        .gte('created_at', rangeStart.toISOString());

      const tokenStatsInRange = rangeTokenStats ?? [];
      const inputTokens = tokenStatsInRange.reduce((sum, s) => sum + (s.input_tokens ?? 0), 0);
      const outputTokens = tokenStatsInRange.reduce((sum, s) => sum + (s.output_tokens ?? 0), 0);
      const cacheReadTokens = tokenStatsInRange.reduce((sum, s) => sum + (s.cached_tokens ?? 0), 0);
      const cacheCreationTokens = tokenStatsInRange.reduce((sum, s) => sum + (s.cache_creation_tokens ?? 0), 0);

      // Cost estimation (using first active model's pricing as average)
      const activeModels = models?.filter(m => m.is_active === 'true') ?? [];
      const avgInputCost = activeModels.length > 0
        ? activeModels.reduce((sum, m) => sum + (m.input_token_cost ?? 0), 0) / activeModels.length
        : 3; // Default $3/1M tokens
      const avgOutputCost = activeModels.length > 0
        ? activeModels.reduce((sum, m) => sum + (m.output_token_cost ?? 0), 0) / activeModels.length
        : 15; // Default $15/1M tokens

      // Convert to actual cost (costs are in micro-dollars per 1M tokens)
      const totalCost = ((inputTokens * avgInputCost) + (outputTokens * avgOutputCost)) / 1000000;
      const avgCostPerRequest = rangeRequests > 0 ? totalCost / rangeRequests : 0;
      const cacheSavings = ((cacheReadTokens * avgInputCost * 0.9) / 1000000); // 90% savings on cached reads

      // === Real Performance Metrics from ai_usage_logs ===
      // Get actual AI usage logs for the time range
      const { data: usageLogs } = await ctx.supabase
        .from('ai_usage_logs')
        .select('status, latency_ms, created_at')
        .gte('created_at', rangeStart.toISOString());

      const logsInRange = usageLogs ?? [];
      const successLogs = logsInRange.filter(log => log.status === 'success');
      const failedLogs = logsInRange.filter(log => log.status !== 'success');

      // Calculate real error rate
      const totalLogs = logsInRange.length;
      const errorRate = totalLogs > 0 ? (failedLogs.length / totalLogs) * 100 : 0;

      // Calculate real response times from successful requests
      const latencies = successLogs
        .map(log => log.latency_ms)
        .filter((l): l is number => l !== null && l !== undefined)
        .sort((a, b) => a - b);

      const avgResponseTime = latencies.length > 0
        ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
        : 0;

      // P95 response time
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95ResponseTime = latencies.length > 0
        ? latencies[p95Index] ?? latencies[latencies.length - 1]
        : 0;

      // === Real Cache Hit Rate from token_stats ===
      const { data: tokenStatsData } = await ctx.supabase
        .from('token_stats')
        .select('input_tokens, cached_tokens')
        .gte('created_at', rangeStart.toISOString());

      const statsInRange = tokenStatsData ?? [];
      const totalInputTokensFromStats = statsInRange.reduce((sum, s) => sum + (s.input_tokens ?? 0), 0);
      const totalCachedTokens = statsInRange.reduce((sum, s) => sum + (s.cached_tokens ?? 0), 0);

      const cacheHitRate = totalInputTokensFromStats > 0
        ? (totalCachedTokens / totalInputTokensFromStats) * 100
        : 0;

      // Health status based on metrics
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
