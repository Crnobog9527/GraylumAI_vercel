import { readMembershipEntitlements } from '../services/membershipEntitlements';
import { maskPhone } from '../shared/mainlandPhone';
import { readPaymentNoticeInbox } from '../services/notify/inbox';
import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { logger } from '../lib/logger';
import { createSafeInternalError, createSafeServiceUnavailableError } from '../lib/publicError';
import {
  readCreditSummary, readUsageStats, utcMonthStart, UsageStatsReadError, type CreditSummary, type UsageStats,
} from '../services/usageStats';
import { applyEntryReplyLanguage, setReplyLanguage } from '../services/replyLanguageSetting';
import { effectiveReplyLocale, replyLocale } from '../shared/replyLanguage';

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
      // PHONE-OTP: the verified number, masked (138****5678); '' for accounts without one.
      phone_masked: maskPhone(ctx.user.phone),
    };
  }),

  /** PHONE-OTP: payment reminders that could not be mailed (no email on the account), for the account page. */
  paymentNoticeInbox: protectedProcedure.query(async ({ ctx }) => (
    ctx.hasSupabaseAdminPrivileges ? readPaymentNoticeInbox(ctx.supabaseAdmin, ctx.profileId) : [])),

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

  /** The language of the public page the user signed in from: always taken, even over an earlier choice (Owner 2026-10-25). */
  applyEntryReplyLanguage: protectedProcedure
    .input(z.object({ language: replyLocale }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'REPLY_LANGUAGE_UNAVAILABLE' });
      try {
        return await applyEntryReplyLanguage(ctx.supabaseAdmin, ctx.profileId, input.language);
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
    // Counted in the database from the per-turn core and the ledger (services/usageStats.ts): the old chat tables get no new
    // rows, and an unpaged ledger read is cut at the row cap. A failed read is an error, never a 0 that looks real.
    let usage: UsageStats;
    let month: CreditSummary;
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new UsageStatsReadError(null);
      [usage, month] = await Promise.all([
        readUsageStats(ctx.supabaseAdmin, ctx.profileId),
        readCreditSummary(ctx.supabaseAdmin, ctx.profileId, utcMonthStart(new Date())),
      ]);
    } catch (error) {
      logger.error('auth', 'user_usage_stats_fetch_failed', { code: error instanceof UsageStatsReadError ? error.code : null });
      throw createSafeServiceUnavailableError(error, '使用统计暂时无法读取，请稍后重试');
    }

    return {
      totalConversations: usage.conversations,
      totalMessages: usage.messages,
      monthlyCreditsUsed: month.totalSpent,
      usageDays: usage.usageDays,
      // No writer records which module a turn used, so there is nothing to rank per user; the placeholder row stays.
      topModules: [{ name: 'AI 智能对话', count: 0 }],
    };
  }),
});
