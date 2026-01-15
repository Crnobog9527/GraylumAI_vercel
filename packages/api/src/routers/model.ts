import { router, publicProcedure, adminProcedure } from '../trpc';
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

  // Admin only: Update AI model configuration
  updateModelConfig: adminProcedure
    .input(z.object({ id: z.string().uuid(), config: z.any() }))
    .mutation(async ({ ctx, input }) => {
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
