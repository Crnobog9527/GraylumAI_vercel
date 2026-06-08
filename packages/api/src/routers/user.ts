import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { logger } from '../lib/logger';
import { createSafeInternalError } from '../lib/publicError';
import { countsAsCreditSpend } from '../services/creditLedger';

export const userRouter = router({
  getUserProfile: protectedProcedure.query(async ({ ctx }) => {
    // 只查询数据库中实际存在的列
    // profiles 表结构: id, credits, created_at, role, status, membership_level,
    //                  is_deleted, nickname, avatar_url, email, last_login_at, last_ip, deleted_at
    const { data: userProfile, error } = await ctx.supabase
      .from('profiles')
      .select('id, email, nickname, avatar_url, role, credits, membership_level, status, created_at')
      .eq('id', ctx.profileId)
      .single();

    // 辅助函数: 从 email 提取显示名称
    const getDisplayName = (email: string | null | undefined): string => {
      if (!email) return '用户';
      return email.split('@')[0] || '用户';
    };

    // 对于任何错误都返回默认值，确保页面能正常加载
    if (error || !userProfile) {
      logger.error('auth', 'user_profile_fetch_failed', {
        code: error?.code ?? null,
      });
      const email = ctx.user?.email ?? '';
      const displayName = getDisplayName(email);
      return {
        id: ctx.profileId,
        email,
        nickname: displayName,
        full_name: displayName,
        avatar_url: null,
        role: 'user',
        credits: 0,
        membership_level: 'free',
        status: 'active',
        auth_provider: ctx.authProvider,
        email_verified: ctx.isEmailVerified,
        created_at: new Date().toISOString(),
      };
    }

    // 返回实际数据，nickname 为空时使用 email 前缀作为显示名称
    const displayName = userProfile.nickname || getDisplayName(userProfile.email);
    return {
      ...userProfile,
      nickname: displayName,
      full_name: displayName,
      auth_provider: ctx.authProvider,
      email_verified: ctx.isEmailVerified,
    };
  }),

  updateUserProfile: protectedProcedure
    .input(z.object({ nickname: z.string().optional(), avatarUrl: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ nickname: input.nickname, avatar_url: input.avatarUrl })
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

  getUserCredits: protectedProcedure.query(async ({ ctx }) => {
    const { data: userProfile, error } = await ctx.supabase
      .from('profiles')
      .select('credits')
      .eq('id', ctx.profileId)
      .single();

    if (error) {
      logger.error('billing', 'user_credits_fetch_failed', {
        code: error.code,
      });
      // 返回默认值而不是抛出错误
      return 0;
    }

    return userProfile?.credits ?? 0;
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

    const [conversationsResult, monthlyTransactionsResult, usageLogsResult, messageCountResult] = await Promise.all([
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
        .from('ai_usage_logs')
        .select('module_name')
        .eq('user_id', ctx.profileId),
      ctx.supabase
        .from('messages')
        .select('id, conversations!inner(user_id)', { count: 'exact', head: true })
        .eq('is_deleted', 'false')
        .eq('conversations.user_id', ctx.profileId),
    ]);

    const conversations = conversationsResult.data ?? [];
    const convError = conversationsResult.error;
    const monthlyTransactions = monthlyTransactionsResult.data ?? [];
    const txError = monthlyTransactionsResult.error;
    const usageLogs = usageLogsResult.data ?? [];
    const logsError = usageLogsResult.error;
    const messageCount = messageCountResult.count ?? 0;
    const msgError = messageCountResult.error;

    // 4. 计算使用天数（有对话的天数）
    const uniqueDays = new Set(conversations.map(c => new Date(c.created_at).toDateString()));

    // 统计模块使用次数
    const moduleUsage: Record<string, number> = {};
    usageLogs.forEach((log: any) => {
      const moduleName = log.module_name || 'AI 智能对话';
      moduleUsage[moduleName] = (moduleUsage[moduleName] || 0) + 1;
    });

    // 排序获取 Top 3
    const topModules = Object.entries(moduleUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

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
