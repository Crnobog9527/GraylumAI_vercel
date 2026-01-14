import { router, publicProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

// Simple ID generator (alternative to nanoid)
function generateInviteCode(length = 10): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

export const invitationRouter = router({
  generateInvitationCode: protectedProcedure
    .mutation(async ({ ctx }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can generate codes, which is NOT recommended for production.
      // You should add a check here to ensure only admins can generate codes.

      const code = generateInviteCode();
      const { data, error } = await ctx.supabase
        .from('invitations')
        .insert({
          code,
          created_by: ctx.profileId,
          status: 'active',
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),

  validateInvitationCode: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('invitations')
        .select('*')
        .eq('code', input.code)
        .eq('status', 'active')
        .single();

      if (error || !data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or used invitation code.' });
      }
      return data;
    }),

  getInvitationHistory: protectedProcedure
    .query(async ({ ctx }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can view history, which is NOT recommended for production.
      // You should add a check here to ensure only admins can view history.

      const { data, error } = await ctx.supabase
        .from('invitations')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),
});
