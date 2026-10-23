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
  priorPro: z.object({ orderId: ref, subscriptionId: ref, providerSubscriptionId: ref.nullable(),
    invoiceId: ref, periodEnd: time, autoRenew: z.boolean() }).strict().optional(),
  merchant: ref,
  // R7 (0297): the order's Stripe mode; the stored hash of an existing test intent is unchanged.
  mode: z.enum(['test', 'live']),
  currency: z.string().regex(/^[a-z]{3}$/),
  plan: z.enum(['pro', 'gold']),
  paidAt: time,
  submittedAt: time,
  periodEnd: time,
  originalCancelAtPeriodEnd: z.boolean(),
  paidMinor: amount.positive(),
  basisMinor: amount.positive(),
  feeMinor: amount,
  // PAY-STRIPE-MP card orders only (0 for a mainland card): the tax charged on top, refunded in full (0253).
  taxMinor: amount.optional(),
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
  taxMinor?: number;
  feeEvidence: string;
  priorPro?: MonthlyRefundTerms['priorPro'];
  snapshot: unknown;
};

/** Pure server-evidence preparation, never approval or dispatch. The real reader and
 * atomic approval/claim transaction live in monthlyRefundService and the narrow SQL RPCs.
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
    || !['monthly', 'yearly'].includes(binding.billingCycle) || snapshot.data.billing_cycle !== binding.billingCycle
    || !['pro', 'gold'].includes(binding.plan) || policy.reason !== 'ordinary'
    || !['membership_first', 'pro_to_gold'].includes(policy.order.kind) || policy.order.channel !== 'stripe'
    || policy.accountState !== 'active') return fail('monthly_scope_required');
  if (binding.orderId !== policy.order.id || binding.userId !== policy.order.userId
    || snapshot.data.currency !== policy.order.currency
    || binding.credits <= 0 || binding.credits > snapshot.data.credits + snapshot.data.bonus_credits
    || binding.billingCycle === 'monthly' && binding.credits !== snapshot.data.credits + snapshot.data.bonus_credits
    || (policy.order.kind === 'pro_to_gold') !== Boolean(binding.priorPro)) return fail('binding_mismatch');
  const end = refundTime(binding.periodEnd);
  if (end === null || end <= refundTime(policy.observedAt)!) return fail('subscription_period_unresolved');
  const parsed = monthlyRefundTermsSchema.safeParse({
    ...(binding.priorPro ? { priorPro: binding.priorPro } : {}),
    kind: 'monthly_first_purchase', orderId: policy.order.id, userId: policy.order.userId,
    ticketId: policy.ticket.id, subscriptionId: binding.subscriptionId,
    providerSubscriptionId: binding.providerSubscriptionId, paymentIntentId: binding.paymentIntentId,
    chargeId: binding.chargeId, invoiceId: binding.invoiceId, merchant: policy.order.merchant,
    mode: policy.order.mode, currency: policy.order.currency, plan: binding.plan,
    paidAt: policy.order.paidAt, submittedAt: policy.ticket.submittedAt, periodEnd: binding.periodEnd,
    originalCancelAtPeriodEnd: binding.originalCancelAtPeriodEnd,
    paidMinor: policy.order.paidMinor, basisMinor: evaluation.quote!.basisMinor,
    feeMinor: evaluation.quote!.feeMinor, ...(binding.taxMinor === undefined ? {} : { taxMinor: binding.taxMinor }),
    netMinor: evaluation.quote!.netMinor + (binding.taxMinor ?? 0), credits: binding.credits,
    feePermitted: policy.feePermitted, feeEvidence: binding.feeEvidence,
    evidenceRefs: [...evaluation.evidenceRefs!, ...(binding.priorPro
      ? [createHash('sha256').update(JSON.stringify(binding.priorPro)).digest('hex')] : [])], snapshot: snapshot.data,
  });
  if (!parsed.success) return fail('monthly_evidence_incomplete');
  return { status: 'eligible', quote: { terms: parsed.data, versionHash: monthlyRefundVersion(parsed.data), executable: false } };
}
