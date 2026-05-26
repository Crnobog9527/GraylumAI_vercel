import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createSafeInternalError } from '../lib/publicError';
import { logger } from '../lib/logger';
import { BILLING_CONSTANTS } from '../types/billing';
import { issueSignedAttachmentUrlsByBatch } from '../lib/ticketAttachments';
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

const promptCategorySchema = z.enum(['writing', 'marketing', 'video', 'business', 'education', 'coding', 'analysis', 'creative', 'other']);
const promptPlatformSchema = z.enum(['all', 'web', 'mobile', 'desktop', 'api']);
const moduleBadgeTypeSchema = z.enum(['new', 'hot', 'recommend']).nullable().optional();
const moduleBooleanSchema = z.boolean();
const promptBatchPatchSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  fullDescription: z.string().max(5000).nullable().optional(),
  content: z.string().min(1).max(10000).optional(),
  systemPrompt: z.string().max(10000).nullable().optional(),
  userPromptTemplate: z.string().max(10000).nullable().optional(),
  modelId: z.string().uuid().nullable().optional(),
  platform: promptPlatformSchema.optional(),
  features: z.array(z.string()).nullable().optional(),
  examples: z.array(z.string()).nullable().optional(),
  userQuestions: z.array(z.string()).nullable().optional(),
  icon: z.string().max(50).optional(),
  imageUrl: z.string().max(1000).nullable().optional(),
  badgeType: moduleBadgeTypeSchema,
  badgeText: z.string().max(80).nullable().optional(),
  creditsDisplay: z.string().max(80).nullable().optional(),
  category: promptCategorySchema.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isFeatured: moduleBooleanSchema.optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: 'At least one patch field is required' },
);

function createAdminOperationError(operation: string, cause: unknown) {
  return createSafeInternalError(cause, `${operation}失败，请稍后重试`);
}

function logAdminEndpointMetric(
  endpoint: string,
  startedAt: number,
  context: Record<string, unknown> = {},
) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  logger.info('api', 'admin_endpoint_profile', {
    endpoint,
    durationMs: Date.now() - startedAt,
    ...context,
  });
}

function serializeTextList(value: string[] | null | undefined) {
  if (!value || value.length === 0) {
    return null;
  }

  const cleaned = value.map((item) => item.trim()).filter(Boolean);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

function summarizeModules(rows: Array<{ active?: boolean | null; category?: string | null; is_featured?: boolean | null }>) {
  const categoryKeys = ['writing', 'marketing', 'video', 'business', 'education', 'coding', 'analysis', 'creative', 'other'];

  return {
    total: rows.length,
    active: rows.filter((module) => module.active === true).length,
    inactive: rows.filter((module) => module.active !== true).length,
    featured: rows.filter((module) => module.is_featured === true).length,
    byCategory: Object.fromEntries(
      categoryKeys.map((category) => [
        category,
        rows.filter((module) => module.category === category).length,
      ]),
    ),
  };
}

type TicketStatusSummary = {
  all: number;
  open: number;
  in_progress: number;
  closed: number;
};

function createEmptyTicketStatusSummary(): TicketStatusSummary {
  return {
    all: 0,
    open: 0,
    in_progress: 0,
    closed: 0,
  };
}

function summarizeTicketStatuses(tickets: Array<{ status: string | null | undefined }> | null | undefined): TicketStatusSummary {
  const summary = createEmptyTicketStatusSummary();

  for (const ticket of tickets ?? []) {
    summary.all += 1;

    if (ticket.status === 'open') summary.open += 1;
    else if (ticket.status === 'in_progress') summary.in_progress += 1;
    else if (ticket.status === 'closed') summary.closed += 1;
  }

  return summary;
}

function parseNumericSetting(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function formatRange(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) {
    return null;
  }

  return {
    min: parseFloat(Math.min(...values).toFixed(2)),
    max: parseFloat(Math.max(...values).toFixed(2)),
  };
}

function convertUsdPer1MToCreditsPer1K(
  usdPer1M: number,
  creditsPerUsd: number,
  tokenPriceMultiplier: number,
): number {
  return parseFloat(
    (
      (usdPer1M * creditsPerUsd * tokenPriceMultiplier) /
      1000
    ).toFixed(2),
  );
}

function convertUsdPer1KSearchToCreditsPer1KSearch(
  usdPer1K: number,
  creditsPerUsd: number,
  tokenPriceMultiplier: number,
): number {
  return parseFloat(
    (
      usdPer1K * creditsPerUsd * tokenPriceMultiplier
    ).toFixed(2),
  );
}

export const adminRouter = router({
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
      invitationsResult,
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

      // Invitations by status
      ctx.supabase.from('invitations').select('status'),

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

    // Calculate invitation statistics
    const invitationStats = {
      total: invitationsResult.data?.length ?? 0,
      active: invitationsResult.data?.filter(i => i.status === 'active').length ?? 0,
      used: invitationsResult.data?.filter(i => i.status === 'used').length ?? 0,
      expired: invitationsResult.data?.filter(i => i.status === 'expired').length ?? 0,
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

    logAdminEndpointMetric('admin.getStatistics', startedAt, {
      queryCount: 10,
      countStrategy: 'planned',
      userCount: result.users.total,
      conversationTotal: result.conversations.total,
    });

    return result;
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
      const startedAt = Date.now();
      let query = ctx.supabase
        .from('profiles')
        .select('id, email, nickname, avatar_url, role, status, membership_level, credits, last_login_at, last_ip, created_at', { count: 'planned' })
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
        throw createAdminOperationError('读取用户列表', error);
      }

      const result = {
        users: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
      };

      logAdminEndpointMetric('admin.getAllUsers', startedAt, {
        queryCount: 1,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.users.length,
      });

      return result;
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
        throw createAdminOperationError('搜索用户', error);
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
        throw createAdminOperationError('更新用户角色', error);
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
      const startedAt = Date.now();
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
        throw createAdminOperationError('读取工单列表', error);
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
        throw createAdminOperationError('读取工单列表', statusCountsError);
      }

      const statusCounts = summarizeTicketStatuses(statusCountRows);

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

      const attachmentBatches = ticketsData.flatMap((ticket) => [
        {
          key: `ticket:${ticket.id}`,
          value: ticket.attachments,
          ownerIds: [ticket.user_id],
        },
        ...((repliesData ?? [])
          .filter(r => r.ticket_id === ticket.id)
          .map((reply) => ({
            key: `reply:${reply.id}`,
            value: reply.attachments,
            ownerIds: [ticket.user_id, reply.user_id],
          }))),
      ]);
      const signedAttachments = await issueSignedAttachmentUrlsByBatch(ctx.supabaseAdmin, attachmentBatches);

      // 组装工单数据
      const tickets = ticketsData.map((ticket) => ({
        ...ticket,
        attachments: signedAttachments.get(`ticket:${ticket.id}`) ?? [],
        user: ticket.user_id ? usersMap.get(ticket.user_id) ?? null : null,
        ticket_replies: (repliesData ?? [])
          .filter(r => r.ticket_id === ticket.id)
          .map((reply) => ({
            ...reply,
            attachments: signedAttachments.get(`reply:${reply.id}`) ?? [],
            user: reply.user_id ? replyUsersMap.get(reply.user_id) ?? null : null,
          })),
      }));

      const result = {
        tickets,
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        statusCounts,
      };

      logAdminEndpointMetric('admin.getAllTickets', startedAt, {
        queryCount: 5,
        countStrategy: 'exact',
        pageSize: input.limit,
        returnedCount: result.tickets.length,
      });

      return result;
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
        throw createAdminOperationError('更新工单状态', error);
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
        throw createAdminOperationError('回复工单', error);
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
        throw createAdminOperationError('读取积分流水', error);
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
          throw createAdminOperationError('读取积分流水', profilesError);
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
      idempotencyKey: z.string().min(1).max(200).optional(),
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

      let previousCredits = profile.credits;
      let appliedNewCredits = newCredits;
      let appliedAdjustment = actualAdjustment;

      if (actualAdjustment !== 0) {
        const ledgerPayload = {
          p_user_id: input.userId,
          p_amount: actualAdjustment,
          p_type: actualAdjustment > 0 ? 'addition' : 'deduction',
          p_description: `[Admin] ${input.reason}`,
          ...(input.idempotencyKey
            ? { p_idempotency_key: `admin_adjustment:${ctx.profileId}:${input.userId}:${input.idempotencyKey}` }
            : {}),
        };

        const { data, error } = await ctx.supabase.rpc('atomic_apply_credit_ledger_entry', ledgerPayload);

        if (error) {
          throw createAdminOperationError('调整用户积分', error);
        }

        const ledgerEntry = data?.[0];
        if (!ledgerEntry) {
          throw createAdminOperationError('调整用户积分', new Error('atomic credit ledger RPC returned no rows'));
        }

        previousCredits = ledgerEntry.balance_before;
        appliedNewCredits = ledgerEntry.balance_after;
        appliedAdjustment = ledgerEntry.amount;
      }

      // Log the activity
      await ctx.supabase.from('user_activity_logs').insert({
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `积分调整: ${appliedAdjustment > 0 ? '+' : ''}${appliedAdjustment}`,
        action_type: 'credit_adjustment',
        details: {
          previousCredits,
          newCredits: appliedNewCredits,
          requestedAdjustment: input.amount,
          appliedAdjustment,
          reason: input.reason,
        },
      });

      return {
        previousCredits,
        newCredits: appliedNewCredits,
        adjustment: appliedAdjustment,
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
      const startedAt = Date.now();
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
        recentLogsResult,
      ] = await Promise.all([
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
          .select('id')
          .eq('user_id', input.userId),

        ctx.supabase
          .from('user_activity_logs')
          .select('*')
          .eq('user_id', input.userId)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (conversationsResult.error) {
        throw createAdminOperationError('读取用户详情', conversationsResult.error);
      }
      if (creditsSpentResult.error) {
        throw createAdminOperationError('读取用户详情', creditsSpentResult.error);
      }
      if (ticketsResult.error) {
        throw createAdminOperationError('读取用户详情', ticketsResult.error);
      }
      if (recentLogsResult.error) {
        throw createAdminOperationError('读取用户详情', recentLogsResult.error);
      }

      // Calculate total credits spent
      const totalCreditsSpent = creditsSpentResult.data?.reduce(
        (sum, t) => sum + Math.abs(t.amount), 0
      ) ?? 0;

      const conversationIds = (conversationsResult.data ?? []).map((conversation) => conversation.id);
      const messageCountResult = conversationIds.length > 0
        ? await ctx.supabase
            .from('messages')
            .select('id', { count: 'planned', head: true })
            .in('conversation_id', conversationIds)
        : { count: 0, error: null };

      if (messageCountResult.error) {
        throw createAdminOperationError('读取用户详情', messageCountResult.error);
      }

      const result = {
        profile,
        stats: {
          totalConversations: conversationsResult.data?.length ?? 0,
          totalMessages: messageCountResult.count ?? 0,
          totalCreditsSpent,
          totalTickets: ticketsResult.data?.length ?? 0,
        },
        recentActivity: recentLogsResult.data ?? [],
      };

      logAdminEndpointMetric('admin.getUserDetails', startedAt, {
        queryCount: conversationIds.length > 0 ? 5 : 4,
        countStrategy: conversationIds.length > 0 ? 'mixed' : 'local_only',
        hasMessagesCount: conversationIds.length > 0,
        recentActivityCount: result.recentActivity.length,
      });

      return result;
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
        throw createAdminOperationError('更新用户状态', error);
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
        throw createAdminOperationError('更新用户会员等级', error);
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
            throw createAdminOperationError('更新用户会员等级', targetPlanError);
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
          throw createAdminOperationError('更新用户会员等级', subscriptionSyncError);
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
      const startedAt = Date.now();
      let query = ctx.supabase
        .from('user_activity_logs')
        .select(`
          *,
          user:profiles!user_activity_logs_user_id_fkey(id, email, nickname, avatar_url),
          admin:profiles!user_activity_logs_admin_id_fkey(id, email, nickname, avatar_url)
        `, { count: 'planned' })
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
        throw createAdminOperationError('读取用户操作日志', error);
      }

      const result = {
        logs: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
      };

      logAdminEndpointMetric('admin.getUserActivityLogs', startedAt, {
        queryCount: 1,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.logs.length,
      });

      return result;
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
        throw createAdminOperationError('读取积分包列表', error);
      }

      return data ?? [];
    }),

  /**
   * Get packages page bootstrap data
   */
  getPackagesDashboard: adminProcedure
    .query(async ({ ctx }) => {
      const [packagesResult, membershipPlansResult] = await Promise.all([
        ctx.supabase
          .from('credit_packages')
          .select('*')
          .order('sort_order', { ascending: true })
          .order('price', { ascending: true }),
        ctx.supabase
          .from('membership_plans')
          .select('*')
          .order('sort_order', { ascending: true }),
      ]);

      if (packagesResult.error) {
        throw createAdminOperationError('读取积分包列表', packagesResult.error);
      }

      if (membershipPlansResult.error) {
        throw createAdminOperationError('读取会员方案列表', membershipPlansResult.error);
      }

      return {
        packages: packagesResult.data ?? [],
        membershipPlans: membershipPlansResult.data ?? [],
      };
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
        throw createAdminOperationError('创建积分包', error);
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
        throw createAdminOperationError('更新积分包', error);
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
        throw createAdminOperationError('删除积分包', error);
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
      const startedAt = Date.now();
      let query = ctx.supabase
        .from('announcements')
        .select('*', { count: 'planned' })
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.activeOnly) {
        query = query.eq('active', true);
      }

      const { data, error, count } = await query;

      if (error) {
        throw createAdminOperationError('读取公告列表', error);
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

      const result = {
        announcements: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };

      logAdminEndpointMetric('admin.getAllAnnouncements', startedAt, {
        queryCount: 2,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.announcements.length,
      });

      return result;
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
        throw createAdminOperationError('创建公告', error);
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
        throw createAdminOperationError('更新公告', error);
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
        throw createAdminOperationError('删除公告', error);
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
        throw createAdminOperationError('读取有效公告', error);
      }

      return data ?? [];
    }),

  // ============================================
  // Feature Module / Module Prompt Management
  // Kept under the legacy "prompts" procedure names because /admin/prompts is
  // the owner-confirmed feature module management entry.
  // ============================================

  getAllPrompts: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      category: promptCategorySchema.optional(),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      let query = ctx.supabase
        .from('modules')
        .select('*', { count: 'planned' })
        .order('sort_order', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.category) {
        query = query.eq('category', input.category);
      }

      if (input.activeOnly) {
        query = query.eq('active', true);
      }

      const { data, error, count } = await query;
      if (error) {
        throw createAdminOperationError('读取功能模块列表', error);
      }

      const statsQuery = await ctx.supabase
        .from('modules')
        .select('active, category, is_featured');

      if (statsQuery.error) {
        throw createAdminOperationError('读取功能模块统计', statsQuery.error);
      }

      const result = {
        prompts: data ?? [],
        modules: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats: summarizeModules(statsQuery.data ?? []),
      };

      logAdminEndpointMetric('admin.getAllPrompts', startedAt, {
        queryCount: 2,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.modules.length,
      });

      return result;
    }),

  getPromptsDashboard: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      category: promptCategorySchema.optional(),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      let modulesQuery = ctx.supabase
        .from('modules')
        .select('*', { count: 'planned' })
        .order('sort_order', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.category) {
        modulesQuery = modulesQuery.eq('category', input.category);
      }

      if (input.activeOnly) {
        modulesQuery = modulesQuery.eq('active', true);
      }

      const [modulesResult, statsQuery, modelsResult] = await Promise.all([
        modulesQuery,
        ctx.supabase
          .from('modules')
          .select('active, category, is_featured'),
        ctx.supabase
          .from('ai_models')
          .select('id, name, model_id, provider, description, enable_web_search, max_tokens')
          .eq('is_active', 'true')
          .order('name'),
      ]);

      if (modulesResult.error) {
        throw createAdminOperationError('读取功能模块列表', modulesResult.error);
      }
      if (statsQuery.error) {
        throw createAdminOperationError('读取功能模块统计', statsQuery.error);
      }
      if (modelsResult.error) {
        throw createAdminOperationError('读取模型列表', modelsResult.error);
      }

      const modules = modulesResult.data ?? [];
      const result = {
        prompts: modules,
        modules,
        total: modulesResult.count ?? 0,
        hasMore: (modulesResult.count ?? 0) > input.offset + input.limit,
        stats: summarizeModules(statsQuery.data ?? []),
        models: modelsResult.data ?? [],
      };

      logAdminEndpointMetric('admin.getPromptsDashboard', startedAt, {
        queryCount: 3,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.modules.length,
        modelCount: result.models.length,
      });

      return result;
    }),

  createPrompt: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      fullDescription: z.string().max(5000).optional(),
      content: z.string().min(1).max(10000),
      systemPrompt: z.string().max(10000).optional(),
      userPromptTemplate: z.string().max(10000).optional(),
      modelId: z.string().uuid().optional(),
      platform: promptPlatformSchema.default('all'),
      features: z.array(z.string()).optional(),
      examples: z.array(z.string()).optional(),
      userQuestions: z.array(z.string()).optional(),
      icon: z.string().max(50).default('Wand2'),
      imageUrl: z.string().max(1000).optional(),
      badgeType: z.enum(['new', 'hot', 'recommend']).optional(),
      badgeText: z.string().max(80).optional(),
      creditsDisplay: z.string().max(80).optional(),
      category: promptCategorySchema.default('other'),
      sortOrder: z.number().int().min(0).max(1000).default(0),
      isFeatured: moduleBooleanSchema.default(false),
      active: moduleBooleanSchema.default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('modules')
        .insert({
          title: input.name,
          description: input.description ?? null,
          full_description: input.fullDescription ?? null,
          prompt_content: input.content,
          system_prompt: input.systemPrompt ?? null,
          user_prompt_template: input.userPromptTemplate ?? null,
          model_id: input.modelId ?? null,
          platform: input.platform,
          features: serializeTextList(input.features),
          examples: serializeTextList(input.examples),
          preparation_questions: serializeTextList(input.userQuestions),
          icon: input.icon,
          image_url: input.imageUrl ?? null,
          badge_type: input.badgeType ?? null,
          badge_text: input.badgeText ?? null,
          credits_display: input.creditsDisplay ?? null,
          category: input.category,
          sort_order: input.sortOrder,
          is_featured: input.isFeatured,
          active: input.active,
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('创建功能模块', error);
      }

      return data;
    }),

  updatePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(500).nullable().optional(),
      fullDescription: z.string().max(5000).nullable().optional(),
      content: z.string().min(1).max(10000).optional(),
      systemPrompt: z.string().max(10000).nullable().optional(),
      userPromptTemplate: z.string().max(10000).nullable().optional(),
      modelId: z.string().uuid().nullable().optional(),
      platform: promptPlatformSchema.optional(),
      features: z.array(z.string()).nullable().optional(),
      examples: z.array(z.string()).nullable().optional(),
      userQuestions: z.array(z.string()).nullable().optional(),
      icon: z.string().max(50).optional(),
      imageUrl: z.string().max(1000).nullable().optional(),
      badgeType: moduleBadgeTypeSchema,
      badgeText: z.string().max(80).nullable().optional(),
      creditsDisplay: z.string().max(80).nullable().optional(),
      category: promptCategorySchema.optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      active: moduleBooleanSchema.optional(),
      isFeatured: moduleBooleanSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.name !== undefined) updateData.title = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.fullDescription !== undefined) updateData.full_description = input.fullDescription;
      if (input.content !== undefined) updateData.prompt_content = input.content;
      if (input.systemPrompt !== undefined) updateData.system_prompt = input.systemPrompt;
      if (input.userPromptTemplate !== undefined) updateData.user_prompt_template = input.userPromptTemplate;
      if (input.modelId !== undefined) updateData.model_id = input.modelId;
      if (input.platform !== undefined) updateData.platform = input.platform;
      if (input.features !== undefined) updateData.features = serializeTextList(input.features);
      if (input.examples !== undefined) updateData.examples = serializeTextList(input.examples);
      if (input.userQuestions !== undefined) updateData.preparation_questions = serializeTextList(input.userQuestions);
      if (input.icon !== undefined) updateData.icon = input.icon;
      if (input.imageUrl !== undefined) updateData.image_url = input.imageUrl;
      if (input.badgeType !== undefined) updateData.badge_type = input.badgeType;
      if (input.badgeText !== undefined) updateData.badge_text = input.badgeText;
      if (input.creditsDisplay !== undefined) updateData.credits_display = input.creditsDisplay;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;
      if (input.active !== undefined) updateData.active = input.active;
      if (input.isFeatured !== undefined) updateData.is_featured = input.isFeatured;

      const { data, error } = await ctx.supabase
        .from('modules')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('更新功能模块', error);
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
      if (input.patch.fullDescription !== undefined) updateData.full_description = input.patch.fullDescription;
      if (input.patch.content !== undefined) updateData.prompt_content = input.patch.content;
      if (input.patch.systemPrompt !== undefined) updateData.system_prompt = input.patch.systemPrompt;
      if (input.patch.userPromptTemplate !== undefined) updateData.user_prompt_template = input.patch.userPromptTemplate;
      if (input.patch.modelId !== undefined) updateData.model_id = input.patch.modelId;
      if (input.patch.platform !== undefined) updateData.platform = input.patch.platform;
      if (input.patch.features !== undefined) updateData.features = serializeTextList(input.patch.features);
      if (input.patch.examples !== undefined) updateData.examples = serializeTextList(input.patch.examples);
      if (input.patch.userQuestions !== undefined) updateData.preparation_questions = serializeTextList(input.patch.userQuestions);
      if (input.patch.icon !== undefined) updateData.icon = input.patch.icon;
      if (input.patch.imageUrl !== undefined) updateData.image_url = input.patch.imageUrl;
      if (input.patch.badgeType !== undefined) updateData.badge_type = input.patch.badgeType;
      if (input.patch.badgeText !== undefined) updateData.badge_text = input.patch.badgeText;
      if (input.patch.creditsDisplay !== undefined) updateData.credits_display = input.patch.creditsDisplay;
      if (input.patch.category !== undefined) updateData.category = input.patch.category;
      if (input.patch.sortOrder !== undefined) updateData.sort_order = input.patch.sortOrder;
      if (input.patch.isFeatured !== undefined) updateData.is_featured = input.patch.isFeatured;

      const { data, error } = await ctx.supabase
        .from('modules')
        .update(updateData)
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw createAdminOperationError('批量更新功能模块', error);
      }

      return {
        updatedIds: (data ?? []).map((module) => module.id),
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
        .from('modules')
        .update({
          active: input.active,
          updated_at: new Date().toISOString(),
        })
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw createAdminOperationError('批量启停功能模块', error);
      }

      return {
        updatedIds: (data ?? []).map((module) => module.id),
        updatedCount: data?.length ?? 0,
        active: input.active,
      };
    }),

  batchDeletePrompts: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('modules')
        .update({
          active: false,
          updated_at: new Date().toISOString(),
        })
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw createAdminOperationError('批量下架功能模块', error);
      }

      return {
        disabledIds: (data ?? []).map((module) => module.id),
        disabledCount: data?.length ?? 0,
      };
    }),

  deletePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('modules')
        .update({
          active: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.id)
        .select('id')
        .single();

      if (error) {
        throw createAdminOperationError('下架功能模块', error);
      }

      return { success: true, disabledId: data?.id ?? input.id };
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
          'new_user_credits',
          'search_surcharge_credits',
          'billing_credits_per_usd',
          'billing_token_price_multiplier',
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

      // Runtime billing reference derived from active model pricing
      const settingsMap: Record<string, unknown> = {};
      settings?.forEach(s => {
        settingsMap[s.key] = s.value;
      });

      const activeMeteredModels = (models ?? []).filter((model) =>
        model.is_active === 'true' || model.is_active === true,
      );
      const creditsPerUsd = parseNumericSetting(
        settingsMap['billing_credits_per_usd'],
        BILLING_CONSTANTS.CREDITS_PER_USD,
      );
      const tokenPriceMultiplier = parseNumericSetting(
        settingsMap['billing_token_price_multiplier'],
        BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER,
      );

      const inputCreditsPer1KValues = activeMeteredModels
        .filter((model) => (model.input_token_cost ?? 0) > 0)
        .map((model) => convertUsdPer1MToCreditsPer1K(
          (model.input_token_cost ?? 0) / 1_000_000,
          creditsPerUsd,
          tokenPriceMultiplier,
        ));

      const outputCreditsPer1KValues = activeMeteredModels
        .filter((model) => (model.output_token_cost ?? 0) > 0)
        .map((model) => convertUsdPer1MToCreditsPer1K(
          (model.output_token_cost ?? 0) / 1_000_000,
          creditsPerUsd,
          tokenPriceMultiplier,
        ));

      const searchCreditsPer1KValues = activeMeteredModels
        .filter((model) => (model.web_search_cost ?? 0) > 0)
        .map((model) =>
          convertUsdPer1KSearchToCreditsPer1KSearch(
            (model.web_search_cost ?? 0) / 1_000_000,
            creditsPerUsd,
            tokenPriceMultiplier,
          ),
        );

      const runtimeBilling = {
        creditsPerUsd,
        tokenPriceMultiplier,
        activeModelCount: activeMeteredModels.length,
        inputCreditsPer1KRange: formatRange(inputCreditsPer1KValues),
        outputCreditsPer1KRange: formatRange(outputCreditsPer1KValues),
        searchCreditsPer1KRange: formatRange(searchCreditsPer1KValues),
        searchSurchargeCredits: parseNumericSetting(settingsMap['search_surcharge_credits'], 0),
        newUserCredits: parseNumericSetting(settingsMap['new_user_credits'], 100),
      };

      return {
        transactions: transactionStats,
        users: userStats,
        packages: packageStats,
        dailyChart: dailyChartData,
        apiStats,
        modelStats,
        financeOverview,
        runtimeBilling,
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
        throw createAdminOperationError('读取会员方案列表', error);
      }

      return data ?? [];
    }),

  /**
   * Get settings page bootstrap data
   */
  getSettingsDashboard: adminProcedure
    .query(async ({ ctx }) => {
      const [systemSettingsResult, membershipPlansResult] = await Promise.all([
        ctx.supabase.from('system_settings').select('key, value'),
        ctx.supabase
          .from('membership_plans')
          .select('*')
          .order('sort_order', { ascending: true }),
      ]);

      if (systemSettingsResult.error) {
        throw createAdminOperationError('读取系统设置', systemSettingsResult.error);
      }

      if (membershipPlansResult.error) {
        throw createAdminOperationError('读取会员方案列表', membershipPlansResult.error);
      }

      return {
        systemSettings: Object.fromEntries(
          (systemSettingsResult.data ?? []).map((setting) => [setting.key, setting.value]),
        ),
        membershipPlans: membershipPlansResult.data ?? [],
      };
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
        throw createAdminOperationError('创建会员方案', error);
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
        throw createAdminOperationError('更新会员方案', error);
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
        throw createAdminOperationError('删除会员方案', error);
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
          error: '自动清理失败，请稍后重试',
        });

        throw createSafeInternalError(error, '对话清理失败，请稍后重试');
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
          .select('id, name, model_id, provider, input_token_cost, output_token_cost, web_search_cost, is_active'),
        ctx.supabase
          .from('token_stats')
          .select('model_used, total_credits, total_cost_usd, input_tokens, output_tokens, cached_tokens, cache_creation_tokens, created_at')
          .gte('created_at', rangeStartIso),
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
          conversationCount: conversationsByModel.get(model.model_id) ?? 0,
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

      const totalCost = tokenStatsInRange.reduce(
        (sum, stat) => sum + parseFloat(stat.total_cost_usd ?? '0'),
        0
      );
      const avgCostPerRequest = rangeRequests > 0 ? totalCost / rangeRequests : 0;
      const cacheSavings = tokenStatsInRange.reduce((sum, stat) => {
        const model = models.find((item) => item.model_id === stat.model_used);
        if (!model) return sum;
        return sum + (((stat.cached_tokens ?? 0) * (model.input_token_cost ?? 0) * 0.9) / 1_000_000_000_000);
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
});
