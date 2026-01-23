import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const userRouter = router({
  getUserProfile: protectedProcedure.query(async ({ ctx }) => {
    // 只选择确定存在的基础列，避免因不存在的列导致查询失败
    const { data: userProfile, error } = await ctx.supabase
      .from('profiles')
      .select('id, email, nickname, full_name, avatar_url, role, credits, membership_level, created_at, updated_at')
      .eq('id', ctx.profileId)
      .single();

    if (error) {
      console.error('getUserProfile error:', error.message, error.code, 'profileId:', ctx.profileId);
      // 如果是 "not found" 错误，返回基本信息而不是抛出错误
      if (error.code === 'PGRST116') {
        // Profile 不存在，返回基于用户信息的默认值
        return {
          id: ctx.profileId,
          email: ctx.user?.email ?? '',
          nickname: '用户',
          full_name: null,
          avatar_url: null,
          role: 'user',
          credits: 0,
          membership_level: 'free',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '获取用户资料失败',
        cause: error,
      });
    }

    return userProfile;
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
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '更新用户资料失败',
          cause: error,
        });
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
