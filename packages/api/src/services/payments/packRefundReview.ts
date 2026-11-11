/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createSafeInternalError } from '../../lib/publicError';

/** Deep review 2026-11-11 item 14: a credit pack refunded outside Graylum (card or wallet) is recorded as 'pack_review' and its
 * credits are held until a person settles it (Owner 2026-10-14: record only, no automatic clawback). The settlement function
 * pay_common_pack_refund_review_settle (0285) had no caller, so the alert's "decide how many credits to take back" had nowhere to
 * go. These read the held packs and settle one, admin only; the function re-checks the admin and the hold under its own locks. */

const ROW = z.object({
  id: z.string().uuid(), user_id: z.string().uuid(), payment_method: z.string().nullable(), currency: z.string().nullable(),
  refund: z.object({
    state: z.literal('pack_review'), packCredits: z.number().nullable().optional(), balanceAtRefund: z.number().nullable().optional(),
    refundedMinor: z.number().nullable().optional(), chargedMinor: z.number().nullable().optional(),
    refundedAt: z.string().nullable().optional(), lastRefundId: z.string().nullable().optional(),
  }),
});
export type HeldPackRefund = { orderId: string; userId: string; method: string | null; currency: string | null; packCredits: number | null;
  balanceAtRefund: number | null; refundedMinor: number | null; chargedMinor: number | null; refundedAt: string | null };

/** The externally refunded packs still waiting for a person, newest first. */
export async function listHeldPackRefunds(db: SupabaseClient): Promise<HeldPackRefund[]> {
  const result = await db.from('payment_orders')
    .select('id,user_id,payment_method,currency,refund:metadata->stripeExternalRefund')
    .eq('item_type', 'credit_package').eq('status', 'refunded')
    .eq('metadata->stripeExternalRefund->>state', 'pack_review').is('metadata->packRefundReview', null)
    .order('updated_at', { ascending: false }).limit(50);
  const rows = z.array(ROW).safeParse(result.data);
  if (result.error || !rows.success) throw createSafeInternalError(result.error ?? rows.error, '待处理的积分包退款暂时无法读取');
  return rows.data.map(row => ({ orderId: row.id, userId: row.user_id, method: row.payment_method, currency: row.currency,
    packCredits: row.refund.packCredits ?? null, balanceAtRefund: row.refund.balanceAtRefund ?? null,
    refundedMinor: row.refund.refundedMinor ?? null, chargedMinor: row.refund.chargedMinor ?? null,
    refundedAt: row.refund.refundedAt ?? null }));
}

const REFUSALS: Record<string, { code: TRPCError['code']; message: string }> = {
  PAY_PACK_REVIEW_ADMIN_REQUIRED: { code: 'FORBIDDEN', message: '只有管理员可以处理积分包退款' },
  PAY_PACK_REVIEW_NOT_HELD: { code: 'PRECONDITION_FAILED', message: '这笔积分包退款不在待处理状态，请刷新后再看' },
  PAY_PACK_REVIEW_CONFLICT: { code: 'CONFLICT', message: '这笔已经按另一种方式处理过，不能改' },
  PAY_PACK_REVIEW_SOURCE_UNKNOWN: { code: 'PRECONDITION_FAILED', message: '这个积分包的剩余积分无法核实，不能收回，只能选择不收回' },
  PAY_PACK_REVIEW_UNKNOWN: { code: 'NOT_FOUND', message: '找不到这笔积分包订单' },
};
const SETTLED = z.object({ decision: z.enum(['clawback', 'kept']), duplicate: z.boolean(),
  creditsTakenBack: z.number().optional(), creditsShortfall: z.number().optional() }).passthrough();

/** One decision per pack, never changed: 'clawback' takes back what is still unused (never below zero; the shortfall is
 * Graylum's), 'kept' releases the hold and leaves the credits as ordinary balance. A repeat of the same decision is a no-op. */
export async function settleHeldPackRefund(db: SupabaseClient, actorId: string, input: { orderId: string; decision: 'clawback' | 'kept' }) {
  const result = await db.rpc('pay_common_pack_refund_review_settle', { p_actor: actorId, p_order: input.orderId,
    p_decision: input.decision });
  if (result.error) {
    const code = Object.keys(REFUSALS).find(key => result.error!.message?.includes(key));
    if (code) throw new TRPCError(REFUSALS[code]!);
    throw createSafeInternalError(result.error, '积分包退款暂时无法处理，请稍后重试');
  }
  const parsed = SETTLED.safeParse(result.data);
  if (!parsed.success) throw createSafeInternalError(parsed.error, '积分包退款处理结果待核对，请刷新后再看');
  return { decision: parsed.data.decision, duplicate: parsed.data.duplicate,
    creditsTakenBack: parsed.data.creditsTakenBack ?? 0, creditsShortfall: parsed.data.creditsShortfall ?? 0 };
}
