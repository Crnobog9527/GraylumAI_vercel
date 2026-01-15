import { router, publicProcedure, adminProcedure } from '../trpc';
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
  // Admin only: Generate new invitation code
  generateInvitationCode: adminProcedure
    .mutation(async ({ ctx }) => {
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

  // Public: Validate invitation code (for registration)
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

  // Admin only: View invitation history
  getInvitationHistory: adminProcedure
    .query(async ({ ctx }) => {
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
