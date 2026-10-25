import { readMembershipEntitlements } from '../services/membershipEntitlements';
import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { logger } from '../lib/logger';
import { createSafeInternalError, createSafeServiceUnavailableError } from '../lib/publicError';
import { countsAsCreditSpend } from '../services/creditLedger';
import { applyEntryReplyLanguage, setReplyLanguage } from '../services/replyLanguageSetting';
import { effectiveReplyLocale, entryLocale, replyLocale } from '../shared/replyLanguage';

export const userRouter = router({
  getEntitlements: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    if (!ctx.hasSupabaseAdminPrivileges) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'ENTITLEMENTS_UNAVAILABLE' });
    }
    return readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId);
  }),
  getUserProfile: protectedProcedure.query(async ({ ctx }) => {
    // 只查询数据库中实际存在的列
    // profiles 表结构: id, credits, created_at, role, status, membership_level,
    //                  is_deleted, nickname, avatar_url, email, last_login_at, last_ip, deleted_at
    const { data: userProfile, error } = await ctx.supabase
      .from('profiles')
      .select('id, email, nickname, avatar_url, role, credits, membership_level, status, created_at, reply_language')
      .eq('id', ctx.profileId)
      .single();

    // 辅助函数: 从 email 提取显示名称
    const getDisplayName = (email: string | null | undefined): string => {
      if (!email) return '用户';
      return email.split('@')[0] || '用户';
    };

    // 读不到资料时报错，不返回默认会员等级或用户名冒充真实数据
    if (error || !userProfile) {
      logger.error('auth', 'user_profile_fetch_failed', {
        code: error?.code ?? null,
      });
      throw createSafeServiceUnavailableError(error, '个人资料暂时无法读取，请稍后重试');
    }

    // 返回实际数据，nickname 为空时使用 email 前缀作为显示名称
    const displayName = userProfile.nickname || getDisplayName(userProfile.email);
    return {
      ...userProfile,
      nickname: displayName,
      full_name: displayName,
      // CHAT-LANGUAGE: the AI reply language in effect, and whether the user (or a sign-up entry) ever set one.
      reply_language: effectiveReplyLocale(userProfile.reply_language),
      reply_language_set: userProfile.reply_language !== null && userProfile.reply_language !== undefined,
      auth_provider: ctx.authProvider,
      email_verified: ctx.isEmailVerified,
    };
  }),

  updateUserProfile: protectedProcedure
    .input(z.object({ nickname: z.string().trim().min(1).max(80).optional(), avatarUrl: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      // Only nickname is user-writable (0144). /api/upload returns private paths, not avatar URLs.
      if (input.avatarUrl !== undefined || input.nickname === undefined) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '目前只支持修改昵称' });
      }
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ nickname: input.nickname })
        .eq('id', ctx.profileId)
        .select('id, email, nickname, avatar_url, role, credits, membership_level, status, created_at')
        .single();

      if (error) {
        logger.error('auth', 'user_profile_update_failed', {
          code: error.code,
        });
        throw createSafeInternalError(error, '更新个人资料失败，请稍后重试');
      }

      return data;
    }),

  /** CHAT-LANGUAGE (Owner 2026-10-24, A): the language every AI reply is written in; applies to new replies. */
  setReplyLanguage: protectedProcedure
    .input(z.object({ language: replyLocale }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'REPLY_LANGUAGE_UNAVAILABLE' });
      try {
        return { language: await setReplyLanguage(ctx.supabaseAdmin, ctx.profileId, input.language) };
      } catch (error) {
        logger.error('auth', 'reply_language_save_failed', {});
        throw createSafeInternalError(error, '语言设置保存失败，请稍后重试');
      }
    }),

  /** The sign-up entry's language (the Traditional Chinese pages): set only while the user never chose one. */
  applyEntryReplyLanguage: protectedProcedure
    .input(z.object({ language: entryLocale }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'REPLY_LANGUAGE_UNAVAILABLE' });
      try {
        return { language: await applyEntryReplyLanguage(ctx.supabaseAdmin, ctx.profileId, input.language) };
      } catch (error) {
        logger.error('auth', 'reply_language_save_failed', {});
        throw createSafeInternalError(error, '语言设置保存失败，请稍后重试');
      }
    }),

  /**
   * 获取用户使用统计
   * - 累计对话次数
   * - 累计消息数
   * - 本月消耗积分
   * - 使用天数
   * - 最常使用功能 Top 3
   */
  getUserUsageStats: protectedProcedure.query(async ({ ctx }) => {
    // 计算本月开始时间
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [conversationsResult, monthlyTransactionsResult, messageCountResult] = await Promise.all([
      ctx.supabase
        .from('conversations')
        .select('created_at')
        .eq('user_id', ctx.profileId),
      ctx.supabase
        .from('credit_transactions')
        .select('*')
        .eq('user_id', ctx.profileId)
        .gte('created_at', monthStart),
      ctx.supabase
        .from('messages')
        .select('id, conversations!inner(user_id)', { count: 'exact', head: true })
        .eq('is_deleted', 'false')
        .eq('conversations.user_id', ctx.profileId),
    ]);

    // 任一查询失败时报错，不返回 0 冒充真实统计
    const readError = conversationsResult.error ?? monthlyTransactionsResult.error ?? messageCountResult.error;
    if (readError) {
      logger.error('auth', 'user_usage_stats_fetch_failed', { code: readError.code ?? null });
      throw createSafeServiceUnavailableError(readError, '使用统计暂时无法读取，请稍后重试');
    }
    const conversations = conversationsResult.data ?? [];
    const monthlyTransactions = monthlyTransactionsResult.data ?? [];
    const messageCount = messageCountResult.count ?? 0;

    // 4. 计算使用天数（有对话的天数）
    const uniqueDays = new Set(conversations.map(c => new Date(c.created_at).toDateString()));

    // ai_usage_logs has no module_name column and no writer records modules, so there is no
    // per-user module source to rank; keep the placeholder instead of a query that always fails.
    const topModules: Array<{ name: string; count: number }> = [];

    // 计算本月消耗积分总和
    const monthlyCreditsUsed = monthlyTransactions.reduce(
      (sum, tx) => sum + (countsAsCreditSpend(tx) ? Math.abs(tx.amount) : 0),
      0
    );

    return {
      totalConversations: conversations?.length ?? 0,
      totalMessages: messageCount ?? 0,
      monthlyCreditsUsed,
      usageDays: uniqueDays.size,
      topModules: topModules.length > 0 ? topModules : [
        { name: 'AI 智能对话', count: 0 },
      ],
    };
  }),
});
