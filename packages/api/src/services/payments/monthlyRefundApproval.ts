/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { purchaseSnapshotSchema } from './contracts';
import { evaluateRefundPolicy, type RefundPolicyInput } from './refundPolicy';
import { refundTime } from './refundMoney';

const ref = z.string().trim().min(1).max(160);
const time = z.string().refine(value => refundTime(value) !== null);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const monthlyRefundTermsSchema = z.object({
  kind: z.literal('monthly_first_purchase'),
  orderId: ref,
  userId: ref,
  ticketId: ref,
  subscriptionId: ref,
  providerSubscriptionId: ref,
  paymentIntentId: ref,
  chargeId: ref,
  invoiceId: ref,
  merchant: ref,
  mode: z.literal('test'),
  currency: z.string().regex(/^[a-z]{3}$/),
  plan: z.enum(['pro', 'gold']),
  paidAt: time,
  submittedAt: time,
  periodEnd: time,
  originalCancelAtPeriodEnd: z.boolean(),
  paidMinor: amount.positive(),
  basisMinor: amount.positive(),
  feeMinor: amount,
  netMinor: amount.positive(),
  credits: amount.positive().max(2147483647),
  feePermitted: z.enum(['confirmed', 'not_permitted']),
  feeEvidence: ref,
  evidenceRefs: z.array(ref).min(4),
  snapshot: purchaseSnapshotSchema,
}).strict();
export type MonthlyRefundTerms = z.infer<typeof monthlyRefundTermsSchema>;
export type MonthlyRefundQuote = { terms: MonthlyRefundTerms; versionHash: string; executable: false };

// Stable schema key order; observedAt is a freshness check, not a new approval identity.
export function monthlyRefundVersion(terms: MonthlyRefundTerms): string {
  return createHash('sha256').update(JSON.stringify(monthlyRefundTermsSchema.parse(terms))).digest('hex');
}

type Binding = {
  orderId: string;
  userId: string;
  subscriptionId: string;
  providerSubscriptionId: string;
  paymentIntentId: string;
  chargeId: string;
  invoiceId: string;
  plan: 'pro' | 'gold' | 'unknown';
  billingCycle: string;
  periodEnd: string;
  originalCancelAtPeriodEnd: boolean;
  credits: number;
  feeEvidence: string;
  snapshot: unknown;
};

/** Pure server-evidence preparation, never approval or dispatch. The real reader and
 * atomic approval/claim transaction are deliberately NOT connected in this slice.
 * Binding must come from the original order/provider/grants, never request fields.
 */
export function prepareMonthlyRefundQuote(policy: RefundPolicyInput, binding: Binding):
  | { status: 'eligible'; quote: MonthlyRefundQuote }
  | { status: 'review_required' | 'rejected'; reason: string; executable: false } {
  const fail = (reason: string) => ({ status: 'review_required' as const, reason, executable: false as const });
  const evaluation = evaluateRefundPolicy(policy);
  if (evaluation.status !== 'eligible') {
    return { status: evaluation.status, reason: evaluation.reason, executable: false };
  }
  const snapshot = purchaseSnapshotSchema.safeParse(binding.snapshot);
  if (!snapshot.success || snapshot.data.item_type !== 'membership_plan'
    || snapshot.data.billing_cycle !== 'monthly' || binding.billingCycle !== 'monthly'
    || !['pro', 'gold'].includes(binding.plan) || policy.reason !== 'ordinary'
    || policy.order.kind !== 'membership_first' || policy.order.channel !== 'stripe'
    || policy.order.mode !== 'test' || policy.accountState !== 'active') return fail('monthly_scope_required');
  if (binding.orderId !== policy.order.id || binding.userId !== policy.order.userId
    || snapshot.data.currency !== policy.order.currency
    || binding.credits !== snapshot.data.credits + snapshot.data.bonus_credits) return fail('binding_mismatch');
  const end = refundTime(binding.periodEnd);
  if (end === null || end <= refundTime(policy.observedAt)!) return fail('subscription_period_unresolved');
  const parsed = monthlyRefundTermsSchema.safeParse({
    kind: 'monthly_first_purchase', orderId: policy.order.id, userId: policy.order.userId,
    ticketId: policy.ticket.id, subscriptionId: binding.subscriptionId,
    providerSubscriptionId: binding.providerSubscriptionId, paymentIntentId: binding.paymentIntentId,
    chargeId: binding.chargeId, invoiceId: binding.invoiceId, merchant: policy.order.merchant,
    mode: 'test', currency: policy.order.currency, plan: binding.plan,
    paidAt: policy.order.paidAt, submittedAt: policy.ticket.submittedAt, periodEnd: binding.periodEnd,
    originalCancelAtPeriodEnd: binding.originalCancelAtPeriodEnd,
    paidMinor: policy.order.paidMinor, basisMinor: evaluation.quote!.basisMinor,
    feeMinor: evaluation.quote!.feeMinor, netMinor: evaluation.quote!.netMinor, credits: binding.credits,
    feePermitted: policy.feePermitted, feeEvidence: binding.feeEvidence,
    evidenceRefs: evaluation.evidenceRefs, snapshot: snapshot.data,
  });
  if (!parsed.success) return fail('monthly_evidence_incomplete');
  return { status: 'eligible', quote: { terms: parsed.data, versionHash: monthlyRefundVersion(parsed.data), executable: false } };
}
