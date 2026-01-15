import { router, publicProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const settingsRouter = router({
  // Public: Get system settings (for display purposes)
  getSystemSettings: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('system_settings')
      .select('*');

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }

    return data.reduce((acc: Record<string, unknown>, setting: { key: string; value: unknown }) => ({
      ...acc,
      [setting.key]: setting.value
    }), {});
  }),

  // Admin only: Update system settings
  updateSystemSettings: adminProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert({ key: input.key, value: input.value }, { onConflict: 'key' })
        .select();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),
});
