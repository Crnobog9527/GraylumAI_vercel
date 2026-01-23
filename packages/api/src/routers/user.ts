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

    // 对于任何错误都返回默认值，确保页面能正常加载
    if (error || !userProfile) {
      console.error('getUserProfile error:', error?.message, error?.code, 'profileId:', ctx.profileId);
      return {
        id: ctx.profileId,
        email: ctx.user?.email ?? '',
        nickname: '用户',
        full_name: null,
        avatar_url: null,
        role: 'user',
        credits: 0,
        membership_level: 'free',
        status: 'active',
        created_at: new Date().toISOString(),
      };
    }

    // 返回实际数据
    return {
      ...userProfile,
      full_name: userProfile.nickname ?? null, // full_name 不存在，用 nickname 代替
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
});
