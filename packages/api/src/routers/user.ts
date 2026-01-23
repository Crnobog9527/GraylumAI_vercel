import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';

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
      console.error('getUserProfile error:', error?.message, error?.code, 'profileId:', ctx.profileId);
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
        created_at: new Date().toISOString(),
      };
    }

    // 返回实际数据，nickname 为空时使用 email 前缀作为显示名称
    const displayName = userProfile.nickname || getDisplayName(userProfile.email);
    return {
      ...userProfile,
      nickname: displayName,
      full_name: displayName,
    };
  }),

  updateUserProfile: protectedProcedure
    .input(z.object({ nickname: z.string().optional(), avatarUrl: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ nickname: input.nickname, avatar_url: input.avatarUrl })
        .eq('id', ctx.profileId);
      if (error) {
        console.error('updateUserProfile error:', error.message, error.code);
        // 即使更新失败也不抛出错误，返回 null
        return null;
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
      console.error('getUserCredits error:', error.message, error.code, 'profileId:', ctx.profileId);
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

    // 1. 获取对话统计
    const { data: conversations, error: convError } = await ctx.supabase
      .from('conversations')
      .select('id, created_at')
      .eq('user_id', ctx.profileId);

    // 2. 获取消息统计
    const { count: messageCount, error: msgError } = await ctx.supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .in('conversation_id', (conversations || []).map(c => c.id));

    // 3. 获取本月积分消耗
    const { data: monthlyTransactions, error: txError } = await ctx.supabase
      .from('credit_transactions')
      .select('amount')
      .eq('user_id', ctx.profileId)
      .lt('amount', 0) // 只统计消耗
      .gte('created_at', monthStart);

    // 4. 计算使用天数（有对话的天数）
    const uniqueDays = new Set(
      (conversations || []).map(c => new Date(c.created_at).toDateString())
    );

    // 5. 获取模块使用统计 (从 ai_usage_logs 或 token_stats 获取)
    const { data: usageLogs, error: logsError } = await ctx.supabase
      .from('ai_usage_logs')
      .select('module_name')
      .eq('user_id', ctx.profileId);

    // 统计模块使用次数
    const moduleUsage: Record<string, number> = {};
    (usageLogs || []).forEach((log: any) => {
      const moduleName = log.module_name || 'AI 智能对话';
      moduleUsage[moduleName] = (moduleUsage[moduleName] || 0) + 1;
    });

    // 排序获取 Top 3
    const topModules = Object.entries(moduleUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

    // 计算本月消耗积分总和
    const monthlyCreditsUsed = (monthlyTransactions || []).reduce(
      (sum, tx) => sum + Math.abs(tx.amount),
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
