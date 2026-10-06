/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { refundConsumptionSchema } from './refundFacts';
import { calculateRefundMoney, refundTime, REFUND_WINDOW_MICROSECONDS } from './refundMoney';

const ref = z.string().trim().min(1).max(160);
const time = z.string().refine(value => refundTime(value) !== null);
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({
  order: z.object({
    id: ref, userId: ref,
    channel: z.enum(['stripe', 'waffo']), mode: z.enum(['test', 'live']), merchant: ref,
    currency: z.string().regex(/^[a-z]{3}$/),
    paidAt: time, paidMinor: minor, refundedMinor: minor,
    paymentEvidenceRef: ref,
    kind: z.enum(['membership_first', 'credit_package', 'pro_to_gold', 'renewal', 'unknown']),
    refundState: z.enum(['none', 'pending', 'refunded', 'disputed', 'unknown']),
  }).strict(),
  // The binding is established by the server/admin; ticket text is not evidence.
  ticket: z.object({ id: ref, userId: ref, orderId: ref, submittedAt: time, bindingEvidenceRef: ref }).strict(),
  observedAt: time,
  consumption: refundConsumptionSchema,
  accountState: z.enum(['active', 'closed', 'violation_terminated', 'unknown']),
  feePermitted: z.enum(['confirmed', 'unknown', 'not_permitted']),
  reason: z.enum(['ordinary', 'feature_reduction', 'unjust_termination']),
  // A reason-specific, already verified contract calculation, NOT an override
  // entered by a customer. PR-4A does not invent tax or unused-credit valuation.
  exceptionBasis: z.object({
    reason: z.enum(['feature_reduction', 'unjust_termination']),
    orderId: ref, currency: z.string(), basisMinor: minor, evidenceRef: ref,
  }).strict().optional(),
}).strict();
export type RefundPolicyInput = z.infer<typeof inputSchema>;
export type RefundQuote = ReturnType<typeof calculateRefundMoney> & { currency: string };
export type RefundPolicyResult = {
  status: 'eligible' | 'rejected' | 'review_required';
  reason: string;
  quote: RefundQuote | null;
  // Always false: eligibility is neither approval nor permission to send cash.
  executable: false;
  orderId?: string;
  ticketId?: string;
  observedAt?: string;
  evidenceRefs?: string[];
  treatment?: 'first_purchase' | 'credit_package' | 'restore_pro'
    | 'end_membership_keep_granted' | 'end_membership_refund_unused_purchased';
};

/** Server-only preview. It MUST NOT be used as a cash authorization or as an
 * atomic consumption lock. PR-4B must re-read, revalidate and claim execution.
 * Caller verifies authoritative payment/dispute facts and ticket binding first.
 */
export function evaluateRefundPolicy(raw: unknown): RefundPolicyResult {
  const result = (status: RefundPolicyResult['status'], reason: string): RefundPolicyResult =>
    ({ status, reason, quote: null, executable: false });
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return result('review_required', 'invalid_or_missing_evidence');
  const input = parsed.data;
  const { order, ticket, consumption } = input;
  const output = (status: RefundPolicyResult['status'], reason: string): RefundPolicyResult => ({
    ...result(status, reason), orderId: order.id, ticketId: ticket.id, observedAt: input.observedAt,
    evidenceRefs: [order.paymentEvidenceRef, ticket.bindingEvidenceRef, consumption.evidenceRef],
  });
  const review = (reason: string) => output('review_required', reason);
  const reject = (reason: string) => output('rejected', reason);
  if (ticket.orderId !== order.id || ticket.userId !== order.userId || consumption.userId !== order.userId) {
    return review('evidence_identity_mismatch');
  }
  const paid = refundTime(order.paidAt)!;
  const submitted = refundTime(ticket.submittedAt)!;
  const observed = refundTime(input.observedAt)!;
  if (submitted < paid || submitted > observed || refundTime(consumption.from)! !== paid
    || refundTime(consumption.through)! !== observed) return review('evidence_time_mismatch');
  if (order.paidMinor <= 0 || order.refundedMinor > order.paidMinor) return review('invalid_payment_amount');
  if (order.refundState === 'disputed') return reject('disputed_order');
  if (order.refundState === 'refunded' || order.refundedMinor > 0) return reject('already_refunded');
  if (order.refundState !== 'none') return review('refund_unresolved');
  if (input.accountState === 'violation_terminated') return reject('violation_terminated');
  if (input.accountState === 'unknown') return review('account_unresolved');
  if (order.kind === 'unknown') return review('purchase_kind_unresolved');
  if (input.reason === 'ordinary') {
    if (order.kind === 'renewal') return reject('renewal');
    if (submitted - paid > REFUND_WINDOW_MICROSECONDS) return reject('outside_refund_window');
    if (consumption.state === 'consumed') return reject('account_consumed_since_payment');
    if (consumption.state !== 'unused' || !consumption.completeAccountHistory || consumption.settlementState !== 'clear') {
      return review('consumption_unresolved');
    }
    if (input.exceptionBasis) return review('unexpected_exception_basis');
  } else {
    const basis = input.exceptionBasis;
    if (!basis) return review('exception_contract_amount_required');
    if (basis.orderId !== order.id || basis.currency !== order.currency || basis.reason !== input.reason) {
      return review('exception_evidence_mismatch');
    }
    if (order.kind === 'credit_package' && input.reason === 'feature_reduction') {
      return review('exception_contract_scope_required');
    }
    // Unused purchased-credit valuation cannot be trusted with unknown settlements.
    if (consumption.state === 'unresolved' || !consumption.completeAccountHistory || consumption.settlementState !== 'clear') {
      return review('consumption_unresolved');
    }
  }
  if (input.feePermitted === 'unknown') return review('fee_requires_review');
  let quote: RefundQuote;
  try {
    quote = { ...calculateRefundMoney({ paidMinor: order.paidMinor, refundedMinor: order.refundedMinor,
      feePermitted: input.feePermitted === 'confirmed',
      basisMinor: input.reason === 'ordinary' ? order.paidMinor : input.exceptionBasis!.basisMinor }), currency: order.currency };
  } catch {
    return review('invalid_refund_amount');
  }
  const treatment = input.reason === 'feature_reduction' ? 'end_membership_keep_granted'
    : input.reason === 'unjust_termination' ? 'end_membership_refund_unused_purchased'
      : order.kind === 'pro_to_gold' ? 'restore_pro'
        : order.kind === 'credit_package' ? 'credit_package' : 'first_purchase';
  const answer = { ...output('eligible', 'manual_approval_required'), quote, treatment } satisfies RefundPolicyResult;
  if (input.exceptionBasis) answer.evidenceRefs!.push(input.exceptionBasis.evidenceRef);
  return answer;
}
