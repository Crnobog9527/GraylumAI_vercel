/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { findCardOrderForPayment } from './cardPaymentLookup';
import { readDisputePayment } from './disputePayment';
import { readSubscription, stopUndeliveredSubscription, stripeStopState } from './cardSubscriptionStop';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';
import { logger } from '../../lib/logger';

export type DisputeRow = {
  id: string; merchant_namespace: string; mode: 'test' | 'live'; provider_dispute_id: string;
  provider_charge_id: string; provider_payment_intent_id: string; provider_invoice_id: string | null;
  provider_subscription_id: string | null; order_id: string | null; subscription_id: string | null;
  freeze_state: string; renewal_stop_state: string; stop_attempts: number; source_review_required: boolean; status: string; outcome: string | null;
  evidence_due_by: string | null; opened_at: string; closed_at: string | null;
  alerted_at: string | null; freeze_alerted_at: string | null; stop_alerted_at: string | null; unmatched_alerted_at: string | null;
  closed_alerted_at: string | null;
};
export type DisputeAlert = (notice: { code: string; disputeId: string; dueBy: string | null }) => void;
const STOP_REQUEST_OPTIONS: Stripe.RequestOptions = { timeout: 2000, maxNetworkRetries: 0 };
const NO_ALERT: DisputeAlert = () => {};
const eventTypes = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
  'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']);
const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const iso = (seconds: number | null | undefined) => seconds == null ? null : new Date(seconds * 1000).toISOString();

/** Event receipts only deduplicate merging; persisted pending side effects are always resumed on replay. */
export async function handlePaymentDispute(db: SupabaseClient, stripe: Stripe, event: Stripe.Event,
  alert: DisputeAlert = NO_ALERT) {
  if (!eventTypes.has(event.type)) return false;
  const scope = await resolveStripeScope(stripe);
  const dispute = event.data.object as Stripe.Dispute;
  if (dispute.object !== 'dispute' || dispute.livemode !== (scope.mode === 'live') || event.livemode !== dispute.livemode) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const payment = await readDisputePayment(stripe, scope, { chargeId: objectId(dispute.charge),
    paymentIntentId: objectId(dispute.payment_intent) });
  const match = await findCardOrderForPayment(db, stripe, scope, payment, { includeWalletMembership: true, includeWalletPacks: true });
  const saved = await db.rpc('pay_dispute_receive', { p_merchant: scope.merchant, p_mode: scope.mode,
    p_event: { id: event.id, type: event.type, created: iso(event.created), disputeId: dispute.id,
      ...payment, openedAt: iso(dispute.created), orderId: match?.order.id ?? null, amount: dispute.amount,
      currency: dispute.currency, reason: dispute.reason, status: dispute.status, dueBy: iso(dispute.evidence_details?.due_by),
      balanceTransactions: dispute.balance_transactions.map(transaction => objectId(transaction)) } });
  if (saved.error || !saved.data) throw new Error('PAY_DISPUTE_RECORD_UNAVAILABLE');
  await resumeDisputeActions(db, stripe, saved.data as DisputeRow, alert);
  return true;
}

async function mark(db: SupabaseClient, disputeId: string, values: Record<string, unknown>) {
  const result = await db.from('payment_disputes').update(values).eq('id', disputeId);
  if (result.error) throw new Error('PAY_DISPUTE_ACTION_RECORD_UNAVAILABLE');
}

export async function resumeDisputeActions(db: SupabaseClient, stripe: Stripe, dispute: DisputeRow,
  alert: DisputeAlert = NO_ALERT) {
  if (dispute.freeze_state === 'external') return true;
  let stopFailed = false;
  if (dispute.order_id && dispute.provider_subscription_id && dispute.renewal_stop_state !== 'confirmed') {
    let confirmed = false;
    // A previous ambiguous update is always observed before the next mutation, including after a process restart.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        let subscription = await readSubscription(stripe, dispute.provider_subscription_id, STOP_REQUEST_OPTIONS);
        let state = stripeStopState(subscription);
        if (!state.stop && !state.canceled) {
          const claim = await db.rpc('pay_dispute_stop_claim', { p_dispute: dispute.id });
          if (claim.error) throw new Error('PAY_DISPUTE_STOP_CLAIM_UNAVAILABLE');
          if (claim.data !== true) break;
          await stopUndeliveredSubscription(stripe, dispute.provider_subscription_id, STOP_REQUEST_OPTIONS);
          subscription = await readSubscription(stripe, dispute.provider_subscription_id, STOP_REQUEST_OPTIONS);
          state = stripeStopState(subscription);
        }
        if (!state.stop && !state.canceled) throw new Error('PAY_DISPUTE_STOP_UNCONFIRMED');
        const saved = await db.rpc('pay_dispute_stop_confirm', { p_dispute: dispute.id, p_canceled: state.canceled });
        if (saved.error) throw new Error('PAY_DISPUTE_STOP_CONFIRM_UNAVAILABLE');
        confirmed = true; break;
      } catch {
        // No raw provider error/objects leave this service. The next iteration reads actual Stripe state first.
      }
    }
    if (!confirmed) {
      const manual = await db.from('payment_disputes').update({ renewal_stop_state: 'manual' }).eq('id', dispute.id)
        .in('renewal_stop_state', ['pending', 'manual']).select('id');
      if (manual.error || !Array.isArray(manual.data)) throw new Error('PAY_DISPUTE_STOP_STATE_UNAVAILABLE');
      stopFailed = manual.data.length > 0;
      if (!stopFailed) {
        const current = await db.from('payment_disputes').select('renewal_stop_state').eq('id', dispute.id).maybeSingle();
        if (current.error || !['confirmed', 'not_applicable'].includes(current.data?.renewal_stop_state)) {
          throw new Error('PAY_DISPUTE_STOP_STATE_UNAVAILABLE');
        }
      }
      if (stopFailed && !dispute.stop_alerted_at && alert !== NO_ALERT) {
        alert({ code: 'PAY_DISPUTE_STOP_MANUAL', disputeId: dispute.id, dueBy: dispute.evidence_due_by });
        await mark(db, dispute.id, { stop_alerted_at: new Date().toISOString() });
      }
    }
  }
  const now = new Date().toISOString();
  if (dispute.order_id && dispute.freeze_state === 'frozen' && !dispute.freeze_alerted_at && alert !== NO_ALERT) {
    alert({ code: dispute.source_review_required ? 'PAY_DISPUTE_SOURCE_REVIEW' : 'PAY_DISPUTE_PAYMENT_FROZEN',
      disputeId: dispute.id, dueBy: dispute.evidence_due_by });
    await mark(db, dispute.id, { freeze_alerted_at: now, ...(dispute.alerted_at ? {} : { alerted_at: now }) });
    dispute.alerted_at ??= now;
  }
  if (!dispute.alerted_at && alert !== NO_ALERT) {
    const code = !dispute.order_id ? 'PAY_DISPUTE_UNMATCHED' : dispute.freeze_state === 'superseded'
      ? 'PAY_DISPUTE_REFUNDED_PAYMENT' : dispute.source_review_required ? 'PAY_DISPUTE_SOURCE_REVIEW' : 'PAY_DISPUTE_OPENED';
    logger.error('billing', code, { disputeId: dispute.id, dueBy: dispute.evidence_due_by });
    alert({ code, disputeId: dispute.id, dueBy: dispute.evidence_due_by });
    await mark(db, dispute.id, { alerted_at: now });
  }
  if (dispute.closed_at && !dispute.closed_alerted_at && alert !== NO_ALERT) {
    alert({ code: 'PAY_DISPUTE_CLOSED', disputeId: dispute.id, dueBy: dispute.evidence_due_by });
    await mark(db, dispute.id, { closed_alerted_at: now });
  }
  if (!dispute.order_id && !dispute.unmatched_alerted_at && alert !== NO_ALERT && Date.now() - Date.parse(dispute.opened_at) > 86400_000) {
    alert({ code: 'PAY_DISPUTE_UNMATCHED_24H', disputeId: dispute.id, dueBy: dispute.evidence_due_by });
    await mark(db, dispute.id, { unmatched_alerted_at: now });
  }
  return !stopFailed;
}

/** Existing 04:00 reconciliation repairs unmatched orders and stops interrupted after the freeze committed. */
export async function reconcilePaymentDisputes(db: SupabaseClient, stripe: Stripe, alert: DisputeAlert = NO_ALERT,
  deadline = Date.now() + 15_000) {
  const scope = await resolveStripeScope(stripe);
  let checked = 0, failed = 0, after: string | undefined;
  for (let page = 0; page < 20; page++) {
    let query = db.from('payment_disputes').select('*').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode)
      .neq('freeze_state', 'external')
      .or('order_id.is.null,renewal_stop_state.in.(pending,manual),alerted_at.is.null,and(freeze_state.eq.frozen,freeze_alerted_at.is.null),'
        + 'and(closed_at.not.is.null,closed_alerted_at.is.null)')
      .order('id', { ascending: true }).limit(50);
    if (after) query = query.gt('id', after);
    const rows = await query;
    if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_DISPUTE_RECONCILE_UNAVAILABLE');
    for (const row of rows.data as DisputeRow[]) {
      if (Date.now() > deadline) return { checked, failed, complete: false };
      checked++;
      try {
        let dispute = row;
        if (!dispute.order_id) {
          const payment = await readDisputePayment(stripe, scope, { chargeId: dispute.provider_charge_id,
            paymentIntentId: dispute.provider_payment_intent_id, invoiceId: dispute.provider_invoice_id });
          const match = await findCardOrderForPayment(db, stripe, scope, payment, { includeWalletMembership: true, includeWalletPacks: true });
          if (match) {
            const linked = await db.rpc('pay_dispute_match', { p_dispute: dispute.id, p_order: match.order.id });
            if (linked.error || !linked.data) throw new Error('PAY_DISPUTE_MATCH_UNAVAILABLE');
            dispute = linked.data as DisputeRow;
          }
        }
        if (!await resumeDisputeActions(db, stripe, dispute, alert)) failed++;
      } catch { failed++; }
    }
    if (rows.data.length < 50) return { checked, failed, complete: true };
    after = (rows.data.at(-1) as DisputeRow).id;
  }
  return { checked, failed, complete: false };
}

/** A payment callback claims pending disputes inside its grant transaction, then resumes provider effects after commit. */
export async function resumeOrderDisputes(db: SupabaseClient, stripe: Stripe, orderId: string, alert: DisputeAlert = NO_ALERT) {
  const rows = await db.from('payment_disputes').select('*').eq('order_id', orderId);
  if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_DISPUTE_ORDER_READ_UNAVAILABLE');
  for (const row of rows.data as DisputeRow[]) await resumeDisputeActions(db, stripe, row, alert);
}
