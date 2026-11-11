/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  ADMIN_ACTIVITY_COLUMNS,
  ADMIN_ACTIVITY_WITH_PROFILES,
  ADMIN_PROFILE_COLUMNS,
  ADMIN_PROFILE_LIST_COLUMNS,
  adminUserSearchFilter,
  recordAdminActivity,
  withUnrecordedLoginFields,
} from '../services/adminUserAccess';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminUserProcedures = {
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
        .select(ADMIN_PROFILE_LIST_COLUMNS, { count: 'planned' })
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      // Apply search filter if provided
      if (input.search) {
        query = query.or(adminUserSearchFilter(input.search));
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
        users: (data ?? []).map(withUnrecordedLoginFields),
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
        .select('id, email, phone, nickname, avatar_url')
        .eq('is_deleted', false)
        .or(adminUserSearchFilter(input.query))
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
        .select(ADMIN_PROFILE_COLUMNS)
        .single();

      if (error) {
        throw createAdminOperationError('更新用户角色', error);
      }

      // Log the activity
      const auditRecorded = await recordAdminActivity(ctx.supabase, {
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

      return { ...data, auditRecorded };
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
      const auditRecorded = await recordAdminActivity(ctx.supabase, {
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
        auditRecorded,
      };
    }),

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
        .select(ADMIN_PROFILE_COLUMNS)
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
          .select(ADMIN_ACTIVITY_COLUMNS)
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
        profile: withUnrecordedLoginFields(profile),
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
        .select(ADMIN_PROFILE_COLUMNS)
        .single();

      if (error) {
        throw createAdminOperationError('更新用户状态', error);
      }

      // Log the activity
      const auditRecorded = await recordAdminActivity(ctx.supabase, {
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

      return { ...data, auditRecorded };
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
        .select(ADMIN_ACTIVITY_WITH_PROFILES, { count: 'planned' })
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
};
