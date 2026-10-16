/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PaymentNoticeError } from './sender';
import type { PaymentNoticeKind, PaymentNoticeParams } from './templates';

// id null: the account is being erased and gets no new notices.
const enqueued = z.object({ id: z.string().uuid().nullable(), state: z.string(), created: z.boolean() }).strict();

/**
 * Records one reminder for (kind, sourceRef, dueKey), e.g. ('wallet_founder_expiry', order id,
 * '2027-03-01:-7d'). Repeated scans and concurrent jobs get the same row back; send it with
 * sendPaymentNotice. Params must be non-personal (dates, amounts, plan ids).
 */
export async function enqueuePaymentNotice(db: Pick<SupabaseClient, 'rpc'>, input: {
  userId: string; kind: PaymentNoticeKind; sourceRef: string; dueKey: string; params?: PaymentNoticeParams;
}) {
  const { data, error } = await db.rpc('payment_notice_enqueue', {
    p_user_id: input.userId, p_kind: input.kind, p_source_ref: input.sourceRef, p_due_key: input.dueKey,
    p_template_params: input.params ?? {},
  });
  if (error) throw new PaymentNoticeError(error.code === '23514' ? 'PAYMENT_NOTICE_INPUT_INVALID' : 'PAYMENT_NOTICE_UNAVAILABLE');
  return enqueued.parse(data);
}
