import { router, publicProcedure, protectedProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeInternalError } from '../lib/publicError';
import { logger } from '../lib/logger';
import { loadInvitationSummary } from '../services/invitationSummary';
import {
  getClientIp,
  loadInvitationRuntimeSettings,
} from '../services/invitationRuntime';

function createInvitationOperationError(operation: string, cause: unknown) {
  return createSafeInternalError(cause, `${operation}失败，请稍后重试`);
}

function getInvitationErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }

  return String(error ?? '');
}

function createInvitationClaimRpcError(error: unknown) {
  const message = getInvitationErrorMessage(error);

  if (
    message.includes('invitation code not found')
    || message.includes('invitation code is not active')
  ) {
    return new TRPCError({ code: 'NOT_FOUND', message: '邀请码无效或已使用。', cause: error });
  }

  if (message.includes('cannot claim own invitation code')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: '不能使用自己的邀请码。', cause: error });
  }

  return createInvitationOperationError('领取邀请码', error);
}

function logInvitationEndpointMetric(
  endpoint: string,
  startedAt: number,
  context: Record<string, unknown> = {},
) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  logger.info('api', 'invitation_endpoint_profile', {
    endpoint,
    durationMs: Date.now() - startedAt,
    ...context,
  });
}

function buildInvitationStats(records: Array<{
  status: string;
  risk_level: string;
  inviter_reward: number | null;
  created_at: string | null;
}>) {
  const stats = {
    total: records.length,
    rewarded: records.filter((record) => record.status === 'rewarded').length,
    rejected: records.filter((record) => record.status === 'rejected').length,
    pending: records.filter((record) => record.status === 'pending' || record.status === 'registered').length,
    highRisk: records.filter((record) => record.risk_level === 'high').length,
    totalRewards: records.reduce((sum, record) => sum + (record.inviter_reward || 0), 0),
  };

  const now = new Date();
  const trend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (6 - index));
    const dateStr = date.toISOString().split('T')[0];
    const dayRecords = records.filter((record) => record.created_at?.split('T')[0] === dateStr);

    return {
      date: `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
      count: dayRecords.length,
      rewarded: dayRecords.filter((record) => record.status === 'rewarded').length,
      rejected: dayRecords.filter((record) => record.status === 'rejected').length,
    };
  });

  const riskDistribution = [
    { name: '低风险', value: records.filter((record) => record.risk_level === 'low').length, color: '#10b981' },
    { name: '中风险', value: records.filter((record) => record.risk_level === 'medium').length, color: '#f59e0b' },
    { name: '高风险', value: records.filter((record) => record.risk_level === 'high').length, color: '#ef4444' },
  ];

  return {
    stats,
    trend,
    riskDistribution,
  };
}

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

export async function validateInvitationCodeExists(
  supabasePublic: Pick<SupabaseClient<any, 'public', any>, 'rpc'>,
  code: string,
) {
  const { data, error } = await supabasePublic.rpc('validate_invitation_code', {
    input_code: code,
  });

  if (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '邀请码校验失败，请稍后重试',
      cause: error,
    });
  }

  if (!data) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or used invitation code.' });
  }

  return { valid: true as const };
}

export const invitationRouter = router({
  // ============================================
  // Invitation Codes Management
  // ============================================

  // Public: Validate invitation code (for registration)
  validateInvitationCode: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ ctx, input }) => {
      return validateInvitationCodeExists(ctx.supabasePublic, input.code);
    }),

  // Protected: Claim an invitation code for the authenticated user
  claimInvitationCode: protectedProcedure
    .input(z.object({
      code: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.hasSupabaseAdminPrivileges) {
        throw createInvitationOperationError('领取邀请码', new Error('Service role unavailable'));
      }
      const normalizedCode = input.code.trim();
      const inviteeId = ctx.profileId;
      const inviteeEmail = ctx.user.email;

      if (!inviteeEmail) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '当前账号缺少邮箱信息。' });
      }

      const { data: invitation, error: invitationError } = await ctx.supabaseAdmin
        .from('invitations')
        .select('code, created_by, status, used_by')
        .eq('code', normalizedCode)
        .maybeSingle();

      if (invitationError) {
        throw createInvitationOperationError('读取邀请码', invitationError);
      }

      if (!invitation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '邀请码无效或已使用。' });
      }

      if (invitation.created_by === inviteeId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '不能使用自己的邀请码。' });
      }

      const { data, error } = await ctx.supabaseAdmin.rpc('atomic_claim_invitation_code', {
        p_invitation_code: normalizedCode,
        p_invitee_id: inviteeId,
        p_invitee_email: inviteeEmail,
        p_claim_status: 'server_decides',
        p_risk_level: 'low',
        p_block_reason: null,
        p_inviter_reward: 0,
        p_invitee_reward: 0,
        p_ip_address: getClientIp(ctx.headers),
        p_user_agent: ctx.headers.get('user-agent'),
      });

      if (error) {
        throw createInvitationClaimRpcError(error);
      }

      const claimResult = Array.isArray(data) ? data[0] : data;

      if (!claimResult || !['rewarded', 'rejected'].includes(claimResult.status)) {
        throw createInvitationOperationError('领取邀请码', new Error('atomic invitation claim RPC returned no rows'));
      }

      if (claimResult.is_idempotent) {
        return { status: 'already_claimed' as const };
      }

      const inviterReward = claimResult.inviter_reward;
      const inviteeReward = claimResult.invitee_reward;
      if (claimResult.status === 'rejected') {
        return {
          status: 'rejected' as const,
          inviterReward,
          inviteeReward,
          blockReason: claimResult.block_reason,
          riskLevel: claimResult.risk_level,
        };
      }

      return {
        status: 'claimed' as const,
        inviterReward,
        inviteeReward,
        riskLevel: claimResult.risk_level,
      };
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
        throw createInvitationOperationError('读取邀请记录', error);
      }
      return data ?? [];
    }),

  // Admin only: Get invitation page bootstrap data
  getAdminInvitationsDashboard: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(500).default(500),
      status: z.enum(['all', 'pending', 'registered', 'rewarded', 'rejected']).default('all'),
      riskLevel: z.enum(['all', 'low', 'medium', 'high']).default('all'),
      search: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      const { limit = 500, status = 'all', riskLevel = 'all', search } = input || {};

      let recordsQuery = ctx.supabase
        .from('invitation_records')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status !== 'all') {
        recordsQuery = recordsQuery.eq('status', status);
      }
      if (riskLevel !== 'all') {
        recordsQuery = recordsQuery.eq('risk_level', riskLevel);
      }
      if (search) {
        recordsQuery = recordsQuery.or(`inviter_email.ilike.%${search}%,invitee_email.ilike.%${search}%,invite_code.ilike.%${search}%`);
      }

      const [statsResult, recordsResult] = await Promise.all([
        ctx.supabase
          .from('invitation_records')
          .select('status, risk_level, inviter_reward, created_at'),
        recordsQuery,
      ]);

      if (statsResult.error) {
        throw createInvitationOperationError('读取邀请统计', statsResult.error);
      }

      if (recordsResult.error) {
        throw createInvitationOperationError('读取邀请记录', recordsResult.error);
      }

      const result = {
        ...buildInvitationStats(statsResult.data ?? []),
        records: recordsResult.data ?? [],
      };

      logInvitationEndpointMetric('invitation.getAdminInvitationsDashboard', startedAt, {
        queryCount: 2,
        recordCount: result.records.length,
        filteredStatus: status,
        filteredRiskLevel: riskLevel,
      });

      return result;
    }),

  // User: Get my invitation records
  getMyInvitationRecords: protectedProcedure
    .query(async ({ ctx }) => {
      const { data, error } = await ctx.supabase
        .from('invitation_records')
        .select('id, created_at, invitee_email, inviter_reward, status')
        .eq('inviter_id', ctx.profileId)
        .order('created_at', { ascending: false });

      if (error) {
        throw createInvitationOperationError('读取我的邀请记录', error);
      }
      return data ?? [];
    }),

  // User: Get or create a reusable invitation dashboard
  getMyInvitationDashboard: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.hasSupabaseAdminPrivileges) {
        throw createInvitationOperationError('读取邀请码面板', new Error('Service role unavailable'));
      }
      const { data: existingInvitation, error: existingInvitationError } = await ctx.supabaseAdmin
        .from('invitations')
        .select('code, created_at')
        .eq('created_by', ctx.profileId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .maybeSingle();

      if (existingInvitationError) {
        throw createInvitationOperationError('读取邀请码面板', existingInvitationError);
      }

      let invitationCode = existingInvitation?.code;

      if (!invitationCode) {
        const code = generateInviteCode();
        const { data: newInvitation, error: createInvitationError } = await ctx.supabaseAdmin
          .from('invitations')
          .insert({
            code,
            created_by: ctx.profileId,
            status: 'active',
          })
          .select('code')
          .eq('created_by', ctx.profileId)
          .single();

        if (createInvitationError || !newInvitation) {
          throw createInvitationOperationError(
            '生成邀请码',
            createInvitationError ?? new Error('生成邀请码失败'),
          );
        }

        invitationCode = newInvitation.code;
      }

      const [recordsResult, settings, summary] = await Promise.all([
        ctx.supabase
          .from('invitation_records')
          .select('id, created_at, invitee_email, inviter_reward, status')
          .eq('inviter_id', ctx.profileId)
          .order('created_at', { ascending: false })
          .limit(10),
        loadInvitationRuntimeSettings(ctx.supabaseAdmin).catch((error) => {
          throw createInvitationOperationError('读取邀请码面板', error);
        }),
        loadInvitationSummary(ctx.supabase, ctx.profileId).catch((error) => {
          throw createInvitationOperationError('读取邀请码面板', error);
        }),
      ]);

      if (recordsResult.error) {
        throw createInvitationOperationError('读取邀请码面板', recordsResult.error);
      }

      const records = recordsResult.data ?? [];
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const { inviterReward, inviteeReward } = settings;

      return {
        invitationCode,
        inviteLink: `${appUrl.replace(/\/$/, '')}/login?action=signup&invite=${encodeURIComponent(invitationCode)}`,
        rewards: {
          inviterReward,
          inviteeReward,
        },
        summary,
        records,
      };
    }),
});
