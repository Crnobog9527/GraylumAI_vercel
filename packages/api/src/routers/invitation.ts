import { router, publicProcedure, protectedProcedure, adminProcedure } from '../trpc';
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
  // ============================================
  // Invitation Codes Management
  // ============================================

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

  // Admin only: View invitation codes history
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

  // ============================================
  // Invitation Records Management
  // ============================================

  // Admin only: Get all invitation records with statistics
  getAllInvitationRecords: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(500).default(500),
      status: z.enum(['all', 'pending', 'registered', 'rewarded', 'rejected']).default('all'),
      riskLevel: z.enum(['all', 'low', 'medium', 'high']).default('all'),
      search: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const { limit = 500, status = 'all', riskLevel = 'all', search } = input || {};

      let query = ctx.supabase
        .from('invitation_records')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status !== 'all') {
        query = query.eq('status', status);
      }
      if (riskLevel !== 'all') {
        query = query.eq('risk_level', riskLevel);
      }
      if (search) {
        query = query.or(`inviter_email.ilike.%${search}%,invitee_email.ilike.%${search}%,invite_code.ilike.%${search}%`);
      }

      const { data, error } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data ?? [];
    }),

  // Admin only: Get invitation statistics
  getInvitationStats: adminProcedure
    .query(async ({ ctx }) => {
      // Get all records for statistics
      const { data: allRecords, error } = await ctx.supabase
        .from('invitation_records')
        .select('status, risk_level, inviter_reward, created_at');

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      const records = allRecords ?? [];

      // Calculate statistics
      const stats = {
        total: records.length,
        rewarded: records.filter(r => r.status === 'rewarded').length,
        rejected: records.filter(r => r.status === 'rejected').length,
        pending: records.filter(r => r.status === 'pending' || r.status === 'registered').length,
        highRisk: records.filter(r => r.risk_level === 'high').length,
        totalRewards: records.reduce((sum, r) => sum + (r.inviter_reward || 0), 0),
      };

      // Calculate last 7 days trend
      const now = new Date();
      const last7Days = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(now);
        date.setDate(date.getDate() - (6 - i));
        const dateStr = date.toISOString().split('T')[0];
        const dayRecords = records.filter(r =>
          r.created_at?.split('T')[0] === dateStr
        );
        return {
          date: `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
          count: dayRecords.length,
          rewarded: dayRecords.filter(r => r.status === 'rewarded').length,
          rejected: dayRecords.filter(r => r.status === 'rejected').length,
        };
      });

      // Calculate risk distribution
      const riskDistribution = [
        { name: '低风险', value: records.filter(r => r.risk_level === 'low').length, color: '#10b981' },
        { name: '中风险', value: records.filter(r => r.risk_level === 'medium').length, color: '#f59e0b' },
        { name: '高风险', value: records.filter(r => r.risk_level === 'high').length, color: '#ef4444' },
      ];

      return {
        stats,
        trend: last7Days,
        riskDistribution,
      };
    }),

  // Admin only: Update invitation record status
  updateInvitationRecord: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      status: z.enum(['pending', 'registered', 'rewarded', 'rejected']).optional(),
      riskLevel: z.enum(['low', 'medium', 'high']).optional(),
      blockReason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {};

      if (input.status !== undefined) {
        updateData.status = input.status;
        if (input.status === 'rewarded') {
          updateData.rewarded_at = new Date().toISOString();
        }
      }
      if (input.riskLevel !== undefined) updateData.risk_level = input.riskLevel;
      if (input.blockReason !== undefined) updateData.block_reason = input.blockReason;

      const { data, error } = await ctx.supabase
        .from('invitation_records')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),

  // User: Get my invitation records
  getMyInvitationRecords: protectedProcedure
    .query(async ({ ctx }) => {
      const { data, error } = await ctx.supabase
        .from('invitation_records')
        .select('*')
        .eq('inviter_id', ctx.profileId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data ?? [];
    }),
});
