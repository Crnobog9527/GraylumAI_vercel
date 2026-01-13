import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';

export const userRouter = router({
  getUserProfile: protectedProcedure.query(async ({ ctx }) => {
    const [userProfile] = await ctx.supabase
      .from('profiles')
      .select('*')
      .eq('id', ctx.user.id);
    return userProfile;
  }),

  updateUserProfile: protectedProcedure
    .input(z.object({ nickname: z.string().optional(), avatarUrl: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ nickname: input.nickname, avatar_url: input.avatarUrl })
        .eq('id', ctx.user.id);
      if (error) throw error;
      return data;
    }),

  getUserCredits: protectedProcedure.query(async ({ ctx }) => {
    const [userProfile] = await ctx.supabase
      .from('profiles')
      .select('credits')
      .eq('id', ctx.user.id);
    return userProfile?.credits ?? 0;
  }),
});
