import { router, publicProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const settingsRouter = router({
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

  updateSystemSettings: protectedProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can update settings, which is NOT recommended for production.
      // You should add a check here to ensure only admins can update settings.

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
