/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { monthlyRefundTermsSchema, monthlyRefundVersion, prepareMonthlyRefundQuote } from './monthlyRefundApproval';
import { readSubscriptionRefundFacts, type SubscriptionRefundPreviewRequest } from './subscriptionRefundPreview';
import { planMonthlyRefundStep, type MonthlyRefundIntent, type MonthlyRefundObservation } from './subscriptionRefundExecution';
import { evidence, objectId, readMonthlyProvider, refundFact, stageKey, type MonthlyStripe } from './monthlyRefundProvider';
import { monthlyRefundPolicyReason } from './monthlyRefundError';
import { resolveStripeScope } from './stripeCheckoutPersistence';

export type MonthlyDb = Pick<SupabaseClient, 'from' | 'rpc'>;
type StoredIntent = MonthlyRefundIntent & {
  kind: 'monthly_first_purchase'; approvedBy: string; status: string; hold: string; revision: number; localVersion: string;
};
const started = () => ({ stop_renewal: null, refund: null, cancel: null, restore_renewal: null });
async function rpc(db: MonthlyDb, name: string, args: Record<string, unknown>) {
  const result = await db.rpc(name, args);
  if (result.error || !result.data) throw new Error('PAY_MONTHLY_TRANSACTION_FAILED', { cause: result.error });
  return result.data;
}
export async function readMonthlyRefundStatus(db: MonthlyDb, orderId: string): Promise<StoredIntent> {
  const { data, error } = await db.from('payment_orders').select('refund_approval').eq('id', orderId).single();
  const i = data?.refund_approval;
  evidence(!error && i?.kind === 'monthly_first_purchase' && i.terms?.orderId === orderId);
  monthlyRefundTermsSchema.parse(i.terms);
  evidence(monthlyRefundVersion(i.terms) === i.versionHash && Number.isSafeInteger(i.revision));
  return i;
}

export async function quoteMonthlyRefund(
  db: MonthlyDb, stripe: MonthlyStripe, actor: string, input: SubscriptionRefundPreviewRequest,
  approved?: StoredIntent,
) {
  const f = await readSubscriptionRefundFacts(db, stripe, actor, input, approved);
  const { data, error } = await db.from('payment_orders').select('purchase_membership_level').eq('id', input.orderId).single();
  evidence(!error && ['pro', 'gold'].includes(data?.purchase_membership_level));
  const mapping = f.evidence.refs.filter(r => r.object_type === 'subscription' && r.subscription_id === f.order.subscription_id);
  evidence(mapping.length === 1);
  const sub = await stripe.subscriptions.retrieve(mapping[0].external_id);
  evidence(sub.items.data.length === 1 && sub.status === 'active' && sub.livemode === false);
  const prepared = prepareMonthlyRefundQuote(f.policy, {
    orderId: f.order.id, userId: f.order.user_id, subscriptionId: f.order.subscription_id!,
    providerSubscriptionId: sub.id, paymentIntentId: f.provider.cash.paymentIntentId, chargeId: f.provider.cash.chargeId,
    invoiceId: f.provider.invoices.find(row => row.orderId === f.order.id)!.id,
    plan: data.purchase_membership_level, billingCycle: f.order.billing_cycle,
    periodEnd: new Date(sub.items.data[0].current_period_end * 1000).toISOString(),
    originalCancelAtPeriodEnd: sub.cancel_at_period_end,
    credits: f.evidence.grants.filter(g => g.source_order_id === f.order.id).reduce((n, g) => n + g.credits_granted, 0),
    feeEvidence: input.feeEvidence, snapshot: f.order.purchase_snapshot,
  });
  if (prepared.status !== 'eligible') throw new Error(monthlyRefundPolicyReason(prepared.reason));
  const provisional: MonthlyRefundIntent = { ...prepared.quote, id: approved?.id ?? '00000000-0000-4000-8000-000000000000',
    claimedAt: null, started: started(), recordedRefund: null };
  const seen = await readMonthlyProvider(stripe, provisional);
  evidence(seen.subscription.preflight === 'clear' && seen.refunds.rows.length === 0);
  const local = await rpc(db, 'pay_common_monthly_refund_approve', { p_actor: actor, p_order: input.orderId,
    p_terms: prepared.quote.terms, p_version: prepared.quote.versionHash, p_local_version: null });
  return { ...prepared.quote, localVersion: String(local.localVersion) };
}
export async function approveMonthlyRefund(db: MonthlyDb, stripe: MonthlyStripe, actor: string,
  input: SubscriptionRefundPreviewRequest & { versionHash: string; localVersion: string }) {
  const existing = await db.from('payment_orders').select('refund_approval').eq('id', input.orderId).single();
  evidence(!existing.error);
  const prior = existing.data?.refund_approval;
  const quote = await quoteMonthlyRefund(db, stripe, actor, input, prior ?? undefined);
  evidence(quote.versionHash === input.versionHash && quote.localVersion === input.localVersion);
  return rpc(db, 'pay_common_monthly_refund_approve', { p_actor: actor, p_order: input.orderId,
    p_terms: quote.terms, p_version: quote.versionHash, p_local_version: quote.localVersion });
}

export async function rejectMonthlyRefund(db: MonthlyDb, actor: string,
  input: { orderId: string; ticketId: string; reason: string }) {
  return rpc(db, 'pay_common_monthly_refund_reject', { p_actor: actor, p_order: input.orderId,
    p_ticket: input.ticketId, p_reason: input.reason });
}
export async function monthlyRefundStatus(db: MonthlyDb, orderId: string) {
  const { data, error } = await db.from('payment_orders').select('refund_approval').eq('id', orderId).single();
  evidence(!error && data?.refund_approval?.kind === 'monthly_first_purchase');
  return data.refund_approval;
}

async function observeLocal(db: MonthlyDb, actor: string, i: StoredIntent): Promise<MonthlyRefundObservation['local']> {
  const { data, error } = await db.from('profiles').select('id,role,status,is_deleted').in('id', [actor, i.terms.userId]);
  evidence(!error && Array.isArray(data));
  const admin = data.find(row => row.id === actor);
  const user = data.find(row => row.id === i.terms.userId);
  const account = user?.status === 'active' && user.is_deleted === 'false' ? 'active'
    : user?.status === 'deleted' && user.is_deleted === 'true' ? 'closed' : 'unknown';
  return { adminActive: admin?.role === 'admin' && admin.status === 'active' && admin.is_deleted === 'false',
    account, approvalVersion: i.versionHash, eligibility: 'unchanged', hold: i.hold === 'held' ? 'held' : 'none' };
}
const pureIntent = (i: StoredIntent): MonthlyRefundIntent => ({ id: i.id, terms: i.terms, versionHash: i.versionHash,
  claimedAt: i.claimedAt, started: i.started, recordedRefund: i.recordedRefund });

/** One bounded recovery pass. Unknown requests stop immediately; the next pass must
 * read the original channel before using the same persisted stage and parameters. */
export async function executeMonthlyRefund(db: MonthlyDb, stripe: MonthlyStripe, actor: string, orderId: string, intentId: string) {
  try {
    for (let step = 0; step < 12; step++) {
      const i = await readMonthlyRefundStatus(db, orderId);
      evidence(i.id === intentId);
      if ('terminalConflict' in i) return { status: 'review_required', intentId, reason: 'recorded_cash_conflict' };
      if (i.status === 'succeeded' || i.status === 'failed') return i;
      if (!i.claimedAt) {
        const quote = await quoteMonthlyRefund(db, stripe, actor, { orderId, ticketId: i.terms.ticketId,
          feePermitted: i.terms.feePermitted, feeEvidence: i.terms.feeEvidence }, i);
        evidence(quote.versionHash === i.versionHash && quote.localVersion === i.localVersion);
        await rpc(db, 'pay_common_monthly_refund_claim', { p_actor: actor, p_order: orderId, p_intent: i.id, p_terms: quote.terms });
        continue;
      }
      const seen = { ...await readMonthlyProvider(stripe, i), local: await observeLocal(db, actor, i) };
      await rpc(db, 'pay_common_monthly_refund_observe', { p_actor: actor, p_order: orderId, p_intent: i.id, p_evidence: seen });
      const decision = planMonthlyRefundStep(pureIntent(i), seen, new Date().toISOString());
      if (decision.kind === 'record_refund') {
        await rpc(db, 'pay_common_monthly_refund_result', { p_order: orderId, p_intent: i.id, p_refund: seen.refunds.rows[0] });
        continue;
      }
      if (decision.kind === 'finalize_success' || decision.kind === 'release_failed_reservation') {
        return rpc(db, 'pay_common_monthly_refund_finish', { p_actor: actor, p_order: orderId, p_intent: i.id, p_evidence: seen });
      }
      if (decision.kind === 'record_before_dispatch') {
        await rpc(db, 'pay_common_monthly_refund_start', { p_actor: actor, p_order: orderId, p_intent: i.id,
          p_revision: i.revision, p_stage: decision.stage, p_evidence: seen });
        continue;
      }
      if (decision.kind !== 'provider_request') return { status: 'review_required', intentId, decision };
      // Recheck and CAS in the DB immediately before EVERY external write, including retries.
      await rpc(db, 'pay_common_monthly_refund_start', { p_actor: actor, p_order: orderId, p_intent: i.id,
        p_revision: i.revision, p_stage: decision.stage, p_evidence: seen });
      if (decision.stage === 'refund') {
        const refund = await stripe.refunds.create({ charge: i.terms.chargeId, amount: i.terms.netMinor,
          metadata: { orderId, refundIntentId: i.id } }, { idempotencyKey: stageKey(i, 'refund') });
        await recordMonthlyRefund(db, stripe, orderId, refund);
      } else if (decision.stage === 'cancel') {
        await stripe.subscriptions.cancel(i.terms.providerSubscriptionId, { invoice_now: false, prorate: false });
      } else {
        await stripe.subscriptions.update(i.terms.providerSubscriptionId, {
          cancel_at_period_end: decision.stage === 'stop_renewal',
          metadata: { graylum_monthly_refund_intent: i.id },
        }, { idempotencyKey: stageKey(i, decision.stage) });
      }
    }
    return { status: 'review_required', intentId, reason: 'bounded_reconciliation' };
  } catch {
    // No exception can clear the durable intent, manufacture a failure or restore cash/credits.
    return { status: 'review_required', intentId, reason: 'monthly_refund_requires_reconciliation' };
  }
}

export async function recordMonthlyRefund(db: MonthlyDb, stripe: MonthlyStripe, orderId: string, refund: Stripe.Refund) {
  const i = await readMonthlyRefundStatus(db, orderId);
  const scope = await resolveStripeScope(stripe);
  evidence(scope.mode === 'test' && scope.merchant === i.terms.merchant);
  evidence(objectId(refund.charge) === i.terms.chargeId && objectId(refund.payment_intent) === i.terms.paymentIntentId
    && refund.currency === i.terms.currency);
  let fact;
  try {
    fact = refundFact(refund, i.terms, i.id);
    evidence(!i.recordedRefund || i.recordedRefund.id === refund.id);
  } catch {
    return rpc(db, 'pay_common_monthly_refund_conflict', { p_order: orderId, p_intent: i.id,
      p_cash: { id: refund.id, chargeId: i.terms.chargeId, paymentIntentId: i.terms.paymentIntentId,
        merchant: scope.merchant, mode: scope.mode, currency: refund.currency, amount: refund.amount, status: refund.status } });
  }
  return rpc(db, 'pay_common_monthly_refund_result', { p_order: orderId, p_intent: i.id, p_refund: fact });
}
