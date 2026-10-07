/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { calculateRefundMoney, refundTime, REFUND_WINDOW_MICROSECONDS } from './refundMoney';
import { monthlyRefundTermsSchema, monthlyRefundVersion } from './monthlyRefundApproval';

const ref = z.string().trim().min(1).max(160);
const time = z.string().refine(value => refundTime(value) !== null);
const refundStatus = z.enum(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']);
const intentSchema = z.object({
  id: z.string().uuid(),
  terms: monthlyRefundTermsSchema,
  versionHash: z.string().regex(/^[a-f0-9]{64}$/),
  claimedAt: time.nullable(),
  // These timestamps must be committed by the future narrow SQL transaction
  // BEFORE its corresponding provider call. They never change on retry.
  started: z.object({ stop_renewal: time.nullable(), refund: time.nullable(),
    cancel: time.nullable(), restore_renewal: time.nullable() }).strict(),
  recordedRefund: z.object({ id: ref, status: refundStatus }).strict().nullable(),
}).strict();
const observationSchema = z.object({
  checkedAt: time,
  merchant: ref,
  mode: z.enum(['test', 'live']),
  local: z.object({
    adminActive: z.boolean(),
    account: z.enum(['active', 'closed', 'unknown', 'violation_terminated']),
    approvalVersion: ref,
    // Unclaimed: freshly re-read eligible quote + atomic claim still required.
    // Claimed: original reservation and source/lifecycle guards still intact.
    eligibility: z.enum(['unchanged', 'changed', 'unknown']),
    hold: z.enum(['none', 'held', 'unknown']),
  }).strict(),
  subscription: z.object({
    id: ref,
    status: z.enum(['active', 'canceled', 'unknown']),
    periodEnd: time,
    cancelAtPeriodEnd: z.boolean(),
    renewalOwnership: z.enum(['original', 'intent', 'unknown']),
    // Complete provider preflight, including other customer invoices, pending
    // invoice items, subscription schedules/updates and original cash/dispute.
    preflight: z.enum(['clear', 'conflict', 'unknown']),
  }).strict(),
  refunds: z.object({
    complete: z.boolean(),
    rows: z.array(z.object({
      id: ref, intentId: ref, orderId: ref, chargeId: ref, paymentIntentId: ref,
      currency: z.string(), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      merchant: ref, mode: z.enum(['test', 'live']), status: refundStatus,
    }).strict()),
  }).strict(),
}).strict();
export type MonthlyRefundIntent = z.infer<typeof intentSchema>;
export type MonthlyRefundObservation = z.infer<typeof observationSchema>;
type Stage = 'stop_renewal' | 'refund' | 'cancel' | 'restore_renewal';
type Decision =
  | { kind: 'review_required'; reason: string }
  | { kind: 'claim'; versionHash: string }
  | { kind: 'record_before_dispatch'; stage: Stage; intentId: string }
  | { kind: 'provider_request'; stage: Stage; operation: 'update_subscription' | 'create_refund' | 'cancel_subscription';
      objectId: string; parameters: Record<string, string | number | boolean | Record<string, string>>; idempotencyKey?: string }
  | { kind: 'record_refund'; refundId: string; status: z.infer<typeof refundStatus> }
  | { kind: 'pending'; refundId: string }
  | { kind: 'finalize_success'; refundId: string }
  | { kind: 'release_failed_reservation'; refundId: string };
export type MonthlyRefundDecision = Decision & { executable: false };
const retryWindow = 20n * 60n * 60n * 1000000n;
const observationWindow = 60n * 1000000n;
const review = (reason: string): Decision => ({ kind: 'review_required', reason });

function request(intent: MonthlyRefundIntent, action: Stage, now: bigint): Decision {
  const started = intent.started[action];
  // Stop/refund share the original claim deadline; a later stage marker must
  // not renew the original 20-hour cash dispatch window.
  if ((action === 'refund' || action === 'stop_renewal')
    && now - refundTime(intent.claimedAt!)! >= retryWindow) return review('post_retry_window_elapsed');
  if (started === null) return { kind: 'record_before_dispatch', stage: action, intentId: intent.id };
  const age = now - refundTime(started)!;
  // DELETE is reconciled by reading the original subscription. It has no
  // POST idempotency-key retention guarantee; the adapter must read again.
  if (action !== 'cancel' && (age < 0 || age >= retryWindow)) return review('post_retry_window_elapsed');
  const key = `pay-common:monthly-refund:${intent.id}:${action}`;
  if (action === 'refund') {
    return { kind: 'provider_request', stage: action, operation: 'create_refund',
      objectId: intent.terms.chargeId, idempotencyKey: key,
      parameters: { charge: intent.terms.chargeId, amount: intent.terms.netMinor,
        metadata: { orderId: intent.terms.orderId, refundIntentId: intent.id } } };
  }
  if (action === 'cancel') {
    return { kind: 'provider_request', stage: action, operation: 'cancel_subscription',
      objectId: intent.terms.providerSubscriptionId, parameters: { invoice_now: false, prorate: false } };
  }
  return { kind: 'provider_request', stage: action, operation: 'update_subscription',
    objectId: intent.terms.providerSubscriptionId, idempotencyKey: key,
    parameters: { cancel_at_period_end: action === 'stop_renewal' } };
}

function next(intent: MonthlyRefundIntent, seen: MonthlyRefundObservation, now: bigint): Decision {
  const terms = intent.terms;
  const { local, subscription, refunds } = seen;
  const observed = refundTime(seen.checkedAt)!;
  if (observed > now || now - observed > observationWindow) return review('fresh_observation_required');
  if (!local.adminActive) return review('admin_required');
  if (terms.snapshot.billing_cycle !== 'monthly' || terms.snapshot.item_type !== 'membership_plan'
    || terms.snapshot.currency !== terms.currency
    || terms.credits !== terms.snapshot.credits + terms.snapshot.bonus_credits) return review('monthly_scope_required');
  const elapsed = refundTime(terms.submittedAt)! - refundTime(terms.paidAt)!;
  if (elapsed < 0 || elapsed > REFUND_WINDOW_MICROSECONDS) return review('application_window_invalid');
  const money = calculateRefundMoney({ paidMinor: terms.paidMinor, refundedMinor: 0,
    basisMinor: terms.paidMinor, feePermitted: terms.feePermitted === 'confirmed' });
  if (terms.basisMinor !== money.basisMinor || terms.feeMinor !== money.feeMinor
    || terms.netMinor !== money.netMinor) return review('amount_mismatch');
  if (monthlyRefundVersion(terms) !== intent.versionHash || local.approvalVersion !== intent.versionHash) {
    return review('approval_changed');
  }
  if (seen.mode !== 'test' || seen.merchant !== terms.merchant
    || subscription.id !== terms.providerSubscriptionId || subscription.periodEnd !== terms.periodEnd) {
    return review('original_identity_changed');
  }
  if (local.account === 'unknown' || local.account === 'violation_terminated') return review('account_unresolved');
  if (!refunds.complete || refunds.rows.length > 1) return review('refund_lookup_incomplete_or_multiple');
  const refund = refunds.rows[0];
  if (refund && (refund.intentId !== intent.id || refund.orderId !== terms.orderId
    || refund.chargeId !== terms.chargeId || refund.paymentIntentId !== terms.paymentIntentId
    || refund.currency !== terms.currency || refund.amount !== terms.netMinor
    || refund.merchant !== terms.merchant || refund.mode !== 'test')) return review('refund_identity_mismatch');
  if (intent.started.cancel && intent.started.restore_renewal
    || (intent.started.cancel || intent.started.restore_renewal || intent.recordedRefund) && !intent.started.refund
    || intent.started.stop_renewal && terms.originalCancelAtPeriodEnd) return review('stage_order_invalid');
  const after = (first: string | null, second: string | null) => first !== null && second !== null
    && refundTime(second)! < refundTime(first)!;
  if (after(intent.started.stop_renewal, intent.started.refund) || after(intent.started.refund, intent.started.cancel)
    || after(intent.started.refund, intent.started.restore_renewal)) return review('stage_order_invalid');
  if (Object.values(intent.started).some(at => at !== null
    && (intent.claimedAt === null || refundTime(at)! < refundTime(intent.claimedAt)! || refundTime(at)! > observed))) {
    return review('dispatch_evidence_invalid');
  }
  if (intent.claimedAt === null) {
    if (refund || intent.recordedRefund || local.account !== 'active' || local.hold !== 'none'
      || local.eligibility !== 'unchanged' || subscription.status !== 'active'
      || subscription.preflight !== 'clear' || refundTime(terms.periodEnd)! <= now
      || subscription.cancelAtPeriodEnd !== terms.originalCancelAtPeriodEnd) return review('claim_prerequisite_failed');
    return { kind: 'claim', versionHash: intent.versionHash };
  }
  if (refundTime(intent.claimedAt)! > observed || local.hold !== 'held') return review('claim_or_reservation_unresolved');
  if (refund && intent.started.refund === null) return review('refund_without_dispatch_identity');
  const recorded = intent.recordedRefund;
  if (intent.started.cancel && recorded?.status !== 'succeeded'
    || intent.started.restore_renewal && !['failed', 'canceled'].includes(recorded?.status ?? '')) {
    return review('stage_outcome_conflict');
  }
  if (recorded && (!refund || refund.id !== recorded.id)) return review('recorded_refund_missing_or_changed');
  if (recorded && ['succeeded', 'failed', 'canceled'].includes(recorded.status) && refund!.status !== recorded.status) {
    return review('terminal_refund_conflict');
  }
  // Already happened cash facts are retained even after account closure or a
  // new preflight conflict. Such conflicts must never erase an external result.
  if (refund && (!recorded || recorded.status !== refund.status)) {
    return { kind: 'record_refund', refundId: refund.id, status: refund.status };
  }
  if (refund?.status === 'pending' || refund?.status === 'requires_action') {
    if (!subscription.cancelAtPeriodEnd && subscription.status !== 'canceled') return review('pending_refund_renewal_changed');
    return { kind: 'pending', refundId: refund.id };
  }
  if (refund?.status === 'succeeded') {
    if (subscription.status === 'canceled') return { kind: 'finalize_success', refundId: refund.id };
    if (local.account !== 'active' || subscription.status !== 'active' || subscription.preflight !== 'clear') {
      return review('cash_succeeded_subscription_unresolved');
    }
    return request(intent, 'cancel', now);
  }
  if (refund?.status === 'failed' || refund?.status === 'canceled') {
    if (subscription.status !== 'active' || subscription.preflight !== 'clear') return review('failed_refund_lifecycle_changed');
    if (!terms.originalCancelAtPeriodEnd && subscription.cancelAtPeriodEnd) {
      // Restore only a stop initiated by this intent, with the same active term.
      if (!intent.started.stop_renewal || subscription.renewalOwnership !== 'intent' || local.account !== 'active' || refundTime(terms.periodEnd)! <= now) {
        return review('renewal_restore_requires_review');
      }
      return request(intent, 'restore_renewal', now);
    }
    if (subscription.cancelAtPeriodEnd !== terms.originalCancelAtPeriodEnd) return review('renewal_state_changed');
    return { kind: 'release_failed_reservation', refundId: refund.id };
  }
  if (local.account !== 'active' || subscription.status !== 'active' || subscription.preflight !== 'clear'
    || local.eligibility !== 'unchanged' || refundTime(terms.periodEnd)! <= now) return review('dispatch_prerequisite_failed');
  // A partial workflow never rewinds: losing the renewal stop after the cash
  // request was sent is a conflict, not permission to create another intent.
  if (!subscription.cancelAtPeriodEnd) {
    if (intent.started.refund || terms.originalCancelAtPeriodEnd) return review('renewal_stop_changed');
    return request(intent, 'stop_renewal', now);
  }
  if (subscription.renewalOwnership !== (terms.originalCancelAtPeriodEnd ? 'original' : 'intent')
    || !terms.originalCancelAtPeriodEnd && !intent.started.stop_renewal) return review('renewal_stop_ownership_unknown');
  return request(intent, 'refund', now);
}

/** Non-executing decision service. No Stripe, Supabase, router or scheduler import.
 * Every decision remains executable=false. A future adapter MUST use the narrow
 * DB transaction to revalidate/claim/CAS before applying it; a returned decision
 * is never a permission token. Real readers, locks, persisted guards, webhook
 * routing and cancellation ownership proof remain blocked on the erasure handoff.
 */
export function planMonthlyRefundStep(rawIntent: unknown, rawObservation: unknown, now: string): MonthlyRefundDecision {
  const intent = intentSchema.safeParse(rawIntent);
  const observation = observationSchema.safeParse(rawObservation);
  const at = refundTime(now);
  if (!intent.success || !observation.success || at === null) {
    return { ...review('invalid_or_missing_evidence'), executable: false };
  }
  try {
    return { ...next(intent.data, observation.data, at), executable: false };
  } catch {
    return { ...review('invalid_or_missing_evidence'), executable: false };
  }
}
