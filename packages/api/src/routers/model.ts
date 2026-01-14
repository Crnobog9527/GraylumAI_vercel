import { router, publicProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const modelRouter = router({
  getAvailableModels: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('ai_models')
      .select('*');

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
    return data;
  }),

  updateModelConfig: protectedProcedure
    .input(z.object({ id: z.string().uuid(), config: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can update models, which is NOT recommended for production.
      // You should add a check here to ensure only admins can update models.

      const { data, error } = await ctx.supabase
        .from('ai_models')
        .update({ config: input.config })
        .eq('id', input.id)
        .select();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),
});
