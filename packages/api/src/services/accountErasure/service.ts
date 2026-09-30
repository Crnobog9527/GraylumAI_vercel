import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { checkRateLimitOrThrow } from '../redisRateLimiter';
import { assertRecentAuthTime, readVerifiedAuthTime } from './reauth';

type Client = SupabaseClient;

/** Auth ban long enough to outlive the account; the Auth user itself is deleted by PR-C. */
const AUTH_BAN_DURATION = '876000h';

const previewSchema = z.object({
  credits: z.number(),
  subscriptionRenewing: z.boolean(),
  subscriptionActiveUntil: z.string().nullable(),
  pendingPayments: z.number(),
  runsInFlight: z.number(),
  closed: z.boolean(),
});
export type AccountErasurePreview = z.infer<typeof previewSchema>;

const confirmSchema = z.object({
  requestId: z.string().uuid(),
  stage: z.string(),
  confirmedAt: z.string(),
  created: z.boolean(),
});

const DB_ERRORS: Record<string, { code: TRPCError['code']; message: string }> = {
  ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING: {
    code: 'PRECONDITION_FAILED',
    message: 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING: 请先在订阅管理中取消自动续费，再申请注销',
  },
  ACCOUNT_ERASURE_ADMIN_DENIED: {
    code: 'FORBIDDEN',
    message: 'ACCOUNT_ERASURE_ADMIN_DENIED: 管理员账号需先取消管理员权限才能注销',
  },
  ACCOUNT_ERASURE_STATUS_DENIED: {
    code: 'FORBIDDEN',
    message: 'ACCOUNT_ERASURE_STATUS_DENIED: 当前账号状态不能申请注销',
  },
};

function unavailable(): TRPCError {
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '注销服务暂时不可用，请稍后重试' });
}

export async function loadAccountErasurePreview(admin: Client, userId: string) {
  const { data, error } = await admin.rpc('account_erasure_preview', { p_profile_id: userId });
  const parsed = previewSchema.safeParse(data);
  if (error || !parsed.success) {
    logger.error('auth', 'account_erasure_preview_failed', { code: error?.code ?? 'invalid_shape' });
    throw unavailable();
  }
  return parsed.data;
}

export async function confirmAccountErasure(input: {
  admin: Client;
  authClient: Client | null;
  headers?: Headers;
  userId: string;
  requestId: string;
  nowMs: number;
}) {
  await checkRateLimitOrThrow(`account-erasure:${input.userId}`, 'auth');
  assertRecentAuthTime(await readVerifiedAuthTime(input), input.nowMs);

  const { data, error } = await input.admin.rpc('account_erasure_confirm', {
    p_profile_id: input.userId,
    p_request_id: input.requestId,
  });
  if (error) {
    const known = Object.keys(DB_ERRORS).find((key) => error.message?.includes(key));
    if (known) throw new TRPCError(DB_ERRORS[known]);
    logger.error('auth', 'account_erasure_confirm_failed', { code: error.code ?? null });
    throw unavailable();
  }
  const result = confirmSchema.safeParse(data);
  if (!result.success) {
    logger.error('auth', 'account_erasure_confirm_invalid_shape');
    throw unavailable();
  }

  // The DB marker already closed the account; Auth revocation is best effort and retried later.
  const authRevoked = await revokeAuthAccess(input.admin, input.userId);
  return { ...result.data, authRevoked };
}

async function revokeAuthAccess(admin: Client, userId: string): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: AUTH_BAN_DURATION });
    if (!error) {
      return true;
    }
    logger.error('auth', 'account_erasure_auth_ban_failed', { status: error.status ?? null });
  } catch {
    logger.error('auth', 'account_erasure_auth_ban_failed', { status: null });
  }
  const { error: noteError } = await admin.rpc('account_erasure_note_error', {
    p_profile_id: userId,
    p_code: 'AUTH_BAN_FAILED',
  });
  if (noteError) {
    logger.error('auth', 'account_erasure_note_error_failed', { code: noteError.code ?? null });
  }
  return false;
}
