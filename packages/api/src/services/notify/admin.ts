/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { PlatformSecretError } from '../platformSecrets/reader';
import { PaymentNoticeError, sendPaymentNotice, type NoticeResult, type SendNoticeDeps } from './sender';
import { PAYMENT_NOTICE_KINDS } from './templates';

/**
 * Admin side of PAY-NOTIFY: the list of notices that need a person, and the "resend with the same
 * idempotency key" button. Both are checked again in the database (active admin, 24-hour window).
 */
export const paymentNoticeResendSchema = z.object({ id: z.string().uuid() }).strict();

const listSchema = z.array(z.object({
  id: z.string().uuid(),
  kind: z.enum(PAYMENT_NOTICE_KINDS),
  state: z.enum(['sending', 'failed', 'unknown', 'manual']),
  manualReason: z.enum(['unknown_unresolved', 'unknown_expired', 'digest_mismatch']).nullable(),
  attempts: z.number().int(),
  lastErrorCode: z.string().nullable(),
  userEmail: z.string().nullable(),
  createdAt: z.string(),
  firstAttemptAt: z.string().nullable(),
  resendable: z.boolean(),
}).strict());
export type PaymentNoticeListItem = z.infer<typeof listSchema>[number];

export async function listPaymentNotices(db: Pick<SupabaseClient, 'rpc'>, actor: string) {
  const { data, error } = await db.rpc('payment_notice_admin_list', { p_actor: actor });
  if (error) {
    if (error.code === '42501') throw new TRPCError({ code: 'FORBIDDEN', message: 'PAYMENT_NOTICE_ACTOR_DENIED' });
    logger.error('billing', 'payment_notice_list_failed', { code: error.code ?? 'unknown' });
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'PAYMENT_NOTICE_UNAVAILABLE' });
  }
  return { items: listSchema.parse(data) };
}

const REFUSALS = new Set(['PAYMENT_NOTICE_NOT_CONFIGURED', 'PAYMENT_NOTICE_TEST_RECIPIENTS_MISSING',
  'PAYMENT_NOTICE_NO_RECIPIENT', 'PAYMENT_NOTICE_RECIPIENT_NOT_ALLOWED', 'PAYMENT_NOTICE_TEMPLATE_MISSING']);

export async function resendPaymentNotice(db: Pick<SupabaseClient, 'rpc'>, actor: string, id: string,
  deps: Omit<SendNoticeDeps, 'actor'>): Promise<NoticeResult> {
  try {
    const result = await sendPaymentNotice(db, id, { ...deps, actor });
    if (result.outcome === 'refused' || result.outcome === 'done') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'PAYMENT_NOTICE_NOT_RESENDABLE' });
    }
    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof PaymentNoticeError) {
      if (error.code === 'PAYMENT_NOTICE_ACTOR_DENIED') throw new TRPCError({ code: 'FORBIDDEN', message: error.code });
      if (REFUSALS.has(error.code)) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.code });
    }
    if (error instanceof PlatformSecretError) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.code });
    }
    logger.error('billing', 'payment_notice_resend_failed', { reason: error instanceof Error ? error.name : 'unknown' });
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'PAYMENT_NOTICE_UNAVAILABLE' });
  }
}
