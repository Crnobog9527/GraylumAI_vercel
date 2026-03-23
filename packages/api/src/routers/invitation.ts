import { router, publicProcedure, protectedProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  evaluateInvitationClaimDecision,
  getChinaDayStartIso,
  getChinaMonthStartIso,
  getClientIp,
  getOneHourAgoIso,
  loadInvitationRuntimeSettings,
} from '../services/invitationRuntime';

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
        .select('code')
        .eq('code', input.code)
        .eq('status', 'active')
        .single();

      if (error || !data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or used invitation code.' });
      }
      return { valid: true as const };
    }),

  // Protected: Claim an invitation code for the authenticated user
  claimInvitationCode: protectedProcedure
    .input(z.object({
      code: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const normalizedCode = input.code.trim();
      const inviteeId = ctx.profileId;
      const inviteeEmail = ctx.user.email;

      if (!inviteeEmail) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '当前账号缺少邮箱信息。' });
      }

      const { data: invitation, error: invitationError } = await ctx.supabase
        .from('invitations')
        .select('code, created_by, status, used_by')
        .eq('code', normalizedCode)
        .eq('status', 'active')
        .maybeSingle();

      if (invitationError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: invitationError.message });
      }

      if (!invitation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '邀请码无效或已使用。' });
      }

      if (invitation.created_by === inviteeId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '不能使用自己的邀请码。' });
      }

      const { data: existingRecord, error: existingRecordError } = await ctx.supabase
        .from('invitation_records')
        .select('id')
        .eq('invite_code', normalizedCode)
        .eq('invitee_id', inviteeId)
        .maybeSingle();

      if (existingRecordError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: existingRecordError.message });
      }

      if (existingRecord) {
        return { status: 'already_claimed' as const };
      }

      const now = new Date();
      const ipAddress = getClientIp(ctx.headers);
      const dayStartIso = getChinaDayStartIso(now);
      const monthStartIso = getChinaMonthStartIso(now);
      const hourStartIso = getOneHourAgoIso(now);

      const [
        inviterProfileResult,
        inviteeProfileResult,
        settings,
        dailyRewardResult,
        totalRewardResult,
        monthlyCountResult,
        sameIpHourResult,
        sameIpDayResult,
      ] = await Promise.all([
        ctx.supabase
          .from('profiles')
          .select('id, email, credits')
          .eq('id', invitation.created_by)
          .single(),
        ctx.supabase
          .from('profiles')
          .select('id, email, credits')
          .eq('id', inviteeId)
          .maybeSingle(),
        loadInvitationRuntimeSettings(ctx.supabase),
        ctx.supabase
          .from('invitation_records')
          .select('inviter_reward')
          .eq('inviter_id', invitation.created_by)
          .eq('status', 'rewarded')
          .gte('created_at', dayStartIso),
        ctx.supabase
          .from('invitation_records')
          .select('inviter_reward')
          .eq('inviter_id', invitation.created_by)
          .eq('status', 'rewarded'),
        ctx.supabase
          .from('invitation_records')
          .select('*', { count: 'exact', head: true })
          .eq('inviter_id', invitation.created_by)
          .eq('status', 'rewarded')
          .gte('created_at', monthStartIso),
        ipAddress
          ? ctx.supabase
              .from('invitation_records')
              .select('*', { count: 'exact', head: true })
              .eq('ip_address', ipAddress)
              .gte('created_at', hourStartIso)
          : Promise.resolve({ count: 0, error: null }),
        ipAddress
          ? ctx.supabase
              .from('invitation_records')
              .select('*', { count: 'exact', head: true })
              .eq('ip_address', ipAddress)
              .gte('created_at', dayStartIso)
          : Promise.resolve({ count: 0, error: null }),
      ]);

      if (inviterProfileResult.error || !inviterProfileResult.data) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: inviterProfileResult.error?.message || '邀请人资料不存在。',
        });
      }

      if (dailyRewardResult.error || totalRewardResult.error || monthlyCountResult.error || sameIpHourResult.error || sameIpDayResult.error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            dailyRewardResult.error?.message
            || totalRewardResult.error?.message
            || monthlyCountResult.error?.message
            || sameIpHourResult.error?.message
            || sameIpDayResult.error?.message
            || '读取邀请限制失败。',
        });
      }

      const inviterProfile = inviterProfileResult.data;
      const inviteeProfile = inviteeProfileResult.data;
      const inviterRewardedToday = (dailyRewardResult.data ?? []).reduce(
        (sum, record) => sum + (Number(record.inviter_reward ?? 0) || 0),
        0
      );
      const inviterRewardedTotal = (totalRewardResult.data ?? []).reduce(
        (sum, record) => sum + (Number(record.inviter_reward ?? 0) || 0),
        0
      );
      const decision = evaluateInvitationClaimDecision({
        settings,
        metrics: {
          inviterRewardedToday,
          inviterRewardedTotal,
          rewardedInvitesThisMonth: monthlyCountResult.count ?? 0,
          sameIpClaimsLastHour: sameIpHourResult.count ?? 0,
          sameIpClaimsToday: sameIpDayResult.count ?? 0,
        },
        ipAddress,
      });
      const inviterReward = decision.status === 'rewarded' ? decision.inviterRewardGranted : 0;
      const inviteeReward = decision.status === 'rewarded' ? decision.inviteeRewardGranted : 0;

      if (inviteeProfile) {
        const updateInviteePayload =
          inviteeReward > 0
            ? {
                credits: Math.max(0, (inviteeProfile.credits ?? 0) + inviteeReward),
              }
            : null;

        if (updateInviteePayload) {
          const { error: updateInviteeError } = await ctx.supabase
            .from('profiles')
            .update(updateInviteePayload)
            .eq('id', inviteeId);

          if (updateInviteeError) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: updateInviteeError.message });
          }
        }
      } else {
        const { error: createInviteeProfileError } = await ctx.supabase
          .from('profiles')
          .insert({
            id: inviteeId,
            email: inviteeEmail,
            role: 'user',
            credits: settings.newUserCredits + inviteeReward,
          });

        if (createInviteeProfileError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: createInviteeProfileError.message });
        }
      }

      if (inviterReward > 0) {
        const { error: updateInviterError } = await ctx.supabase
          .from('profiles')
          .update({
            credits: Math.max(0, (inviterProfile.credits ?? 0) + inviterReward),
          })
          .eq('id', inviterProfile.id);

        if (updateInviterError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: updateInviterError.message });
        }
      }

      const { error: recordError } = await ctx.supabase
        .from('invitation_records')
        .insert({
          invite_code: normalizedCode,
          inviter_id: inviterProfile.id,
          inviter_email: inviterProfile.email,
          invitee_id: inviteeId,
          invitee_email: inviteeEmail,
          status: decision.status,
          risk_level: decision.riskLevel,
          block_reason: decision.blockReason,
          inviter_reward: inviterReward,
          invitee_reward: inviteeReward,
          ip_address: ipAddress,
          user_agent: ctx.headers.get('user-agent'),
          rewarded_at: decision.status === 'rewarded' ? now.toISOString() : null,
        });

      if (recordError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: recordError.message });
      }

      const { error: invitationUpdateError } = await ctx.supabase
        .from('invitations')
          .update({
            status: 'used',
            used_by: inviteeId,
          })
          .eq('code', normalizedCode);

      if (invitationUpdateError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: invitationUpdateError.message });
      }

      const creditTransactions = [
        inviterReward > 0
          ? {
              user_id: inviterProfile.id,
              amount: inviterReward,
              type: 'addition',
              description: `邀请奖励：${inviteeEmail} 注册成功`,
            }
          : null,
        inviteeReward > 0
          ? {
              user_id: inviteeId,
              amount: inviteeReward,
              type: 'addition',
              description: `邀请码奖励：使用 ${normalizedCode} 完成注册`,
            }
          : null,
      ].filter(Boolean);

      if (creditTransactions.length > 0) {
        const { error: transactionError } = await ctx.supabase
          .from('credit_transactions')
          .insert(creditTransactions);

        if (transactionError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: transactionError.message });
        }
      }

      if (decision.status === 'rejected') {
        return {
          status: 'rejected' as const,
          inviterReward,
          inviteeReward,
          blockReason: decision.blockReason,
          riskLevel: decision.riskLevel,
        };
      }

      return {
        status: 'claimed' as const,
        inviterReward,
        inviteeReward,
        riskLevel: decision.riskLevel,
      };
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

  // User: Get or create a reusable invitation dashboard
  getMyInvitationDashboard: protectedProcedure
    .query(async ({ ctx }) => {
      const { data: existingInvitation, error: existingInvitationError } = await ctx.supabase
        .from('invitations')
        .select('code, created_at')
        .eq('created_by', ctx.profileId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .maybeSingle();

      if (existingInvitationError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: existingInvitationError.message });
      }

      let invitationCode = existingInvitation?.code;

      if (!invitationCode) {
        const code = generateInviteCode();
        const { data: newInvitation, error: createInvitationError } = await ctx.supabase
          .from('invitations')
          .insert({
            code,
            created_by: ctx.profileId,
            status: 'active',
          })
          .select('code')
          .single();

        if (createInvitationError || !newInvitation) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: createInvitationError?.message || '生成邀请码失败。',
          });
        }

        invitationCode = newInvitation.code;
      }

      const [recordsResult, settingsResult] = await Promise.all([
        ctx.supabase
          .from('invitation_records')
          .select('*')
          .eq('inviter_id', ctx.profileId)
          .order('created_at', { ascending: false })
          .limit(10),
        ctx.supabase
          .from('system_settings')
          .select('key, value')
          .in('key', ['invite_inviter_reward', 'invite_invitee_reward']),
      ]);

      if (recordsResult.error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: recordsResult.error.message });
      }

      if (settingsResult.error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: settingsResult.error.message });
      }

      const records = recordsResult.data ?? [];
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const settingsMap = new Map((settingsResult.data ?? []).map((setting) => [setting.key, setting.value]));
      const inviterReward = Number(settingsMap.get('invite_inviter_reward') ?? 50) || 50;
      const inviteeReward = Number(settingsMap.get('invite_invitee_reward') ?? 30) || 30;

      return {
        invitationCode,
        inviteLink: `${appUrl.replace(/\/$/, '')}/login?action=signup&invite=${encodeURIComponent(invitationCode)}`,
        rewards: {
          inviterReward,
          inviteeReward,
        },
        summary: {
          totalInvites: records.length,
          rewardedInvites: records.filter((record) => record.status === 'rewarded').length,
          pendingInvites: records.filter((record) => record.status === 'pending' || record.status === 'registered').length,
        },
        records,
      };
    }),
});
