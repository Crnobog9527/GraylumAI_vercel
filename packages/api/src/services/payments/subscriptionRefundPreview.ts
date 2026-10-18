/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { freezePurchaseSnapshot } from './contracts';
import { assembleRefundConsumption } from './refundFacts';
import { refundTime } from './refundMoney';
import { evaluateRefundPolicy, type RefundPolicyResult, type RefundPolicyInput } from './refundPolicy';
import type { RefundRequest, RefundStripe } from './packageRefund';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { disputeAllowsRefund } from './disputeRefundEligibility';
import {
  readPreviewOrder, readSubscriptionRefundEvidence,
  type PreviewDb, type PreviewOrder, type SubscriptionRefundEvidence,
} from './subscriptionRefundEvidence';

export type SubscriptionRefundStripe = RefundStripe & Pick<Stripe, 'invoices' | 'invoicePayments'>;
export type SubscriptionRefundPreviewRequest = Omit<RefundRequest, 'feePermitted'> & {
  feePermitted: 'confirmed' | 'not_permitted' | 'unknown';
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;
function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
const review = (reason: string): RefundPolicyResult => ({ status: 'review_required', reason, quote: null, executable: false });
function scopeMatches(row: { channel?: string; payment_channel?: string | null; mode?: string; payment_mode?: string | null;
  merchant_namespace: string | null }, order: PreviewOrder) {
  // R7 (0297): the refund target's own mode (verifyOrder: test or live); history never mixes modes.
  return (row.channel ?? row.payment_channel) === 'stripe' && (row.mode ?? row.payment_mode) === order.payment_mode
    && row.merchant_namespace === order.merchant_namespace;
}
// PAY-STRIPE-MP: a card subscription order (0222) maps its invoices as 'payment' references, and an international
// card (Managed Payments) charged the pre-tax amount_total plus the tax recorded for that invoice (0237).
const isCard = (order: Pick<PreviewOrder, 'payment_method'>) => order.payment_method === 'card' || order.payment_method === 'card_cn';
function recordedTax(order: PreviewOrder, invoiceId: string) {
  if (order.payment_method !== 'card') return 0;
  const facts = (Array.isArray(order.payment_amount_facts) ? order.payment_amount_facts as Array<Record<string, unknown>> : [])
    .filter(fact => fact.kind === 'tax' && fact.evidence_ref === invoiceId);
  requireEvidence(facts.length, 'PAY_REFUND_TAX_PENDING');
  return facts.reduce((sum, fact) => sum + Math.round(Number(fact.amount) * 100), 0);
}
// A card checkout row is created before payment. Only one Stripe confirmed closed unpaid (0204 'released') is left out
// of history; an open one may already be paid at Stripe before its webhook lands, so it still counts.
const tookMoney = (order: PreviewOrder, refs: SubscriptionRefundEvidence['refs']) => !isCard(order)
  || order.qualification_state !== 'released' || Boolean(order.fulfilled_at)
  || ['paid', 'refunded', 'partially_refunded'].includes(order.payment_status ?? '')
  || refs.some(row => row.order_id === order.id && ['payment', 'invoice'].includes(row.object_type));
function mapped(evidence: SubscriptionRefundEvidence, order: PreviewOrder, kind: string, key: 'order_id' | 'subscription_id', id: string) {
  const refs = evidence.refs.filter(row => row.object_type === kind && row[key] === id);
  requireEvidence(refs.length === 1 && scopeMatches(refs[0], order), 'PAY_REFUND_MAPPING_UNRESOLVED');
  return refs[0].external_id;
}
function verifyOrder(order: PreviewOrder) {
  requireEvidence(order.item_type === 'membership_plan' && order.payment_channel === 'stripe'
    && (order.payment_mode === 'test' || order.payment_mode === 'live') && order.merchant_namespace, 'PAY_REFUND_TEST_SUBSCRIPTION_ONLY');
  const snapshot = freezePurchaseSnapshot(order.purchase_snapshot);
  requireEvidence(snapshot.item_type === 'membership_plan' && snapshot.item_id === order.item_id
    && snapshot.billing_cycle === order.billing_cycle && snapshot.currency === order.currency
    && order.subscription_id && order.fulfilled_at && order.payment_status === 'paid'
    && order.status === 'completed' && !order.refund_status && order.amount_total !== null && order.amount_total > 0,
  'PAY_REFUND_ORDER_UNAVAILABLE');
}

// List *all* invoices for every local subscription, including canceled contracts.
// This catches paid provider invoices that have not yet reached the local webhook.
async function readInvoiceHistory(stripe: SubscriptionRefundStripe, evidence: SubscriptionRefundEvidence, order: PreviewOrder) {
  const invoices: { id: string; orderId: string; paidAt: string; billingReason: string | null }[] = [];
  const seen = new Set<string>();
  requireEvidence(evidence.subscriptions.length > 0 && evidence.subscriptions.length <= 100,
    'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED');
  for (const subscription of evidence.subscriptions) {
    requireEvidence(subscription.user_id === order.user_id && scopeMatches(subscription, order), 'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED');
    freezePurchaseSnapshot(subscription.contract_snapshot);
    const subscriptionId = mapped(evidence, order, 'subscription', 'subscription_id', subscription.id);
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < 20; page++) {
      const result = await stripe.invoices.list({ subscription: subscriptionId, limit: 100, starting_after: cursor });
      requireEvidence(Array.isArray(result.data) && typeof result.has_more === 'boolean', 'PAY_REFUND_PROVIDER_HISTORY_INCOMPLETE');
      for (const invoice of result.data) {
        requireEvidence(!seen.has(invoice.id) && seen.size < 2000, 'PAY_REFUND_PROVIDER_HISTORY_INCOMPLETE');
        seen.add(invoice.id);
        requireEvidence(invoice.object === 'invoice' && invoice.livemode === (order.payment_mode === 'live')
          && objectId(invoice.parent?.subscription_details?.subscription) === subscriptionId,
        'PAY_REFUND_INVOICE_MISMATCH');
        // Open/draft invoices may still complete. They cannot prove a closed history.
        requireEvidence(['paid', 'void', 'uncollectible'].includes(invoice.status ?? ''), 'PAY_REFUND_PROVIDER_HISTORY_UNRESOLVED');
        if (invoice.status !== 'paid') continue;
        const matches = evidence.refs.filter(row => ['invoice', 'payment'].includes(row.object_type)
          && row.external_id === invoice.id && scopeMatches(row, order));
        requireEvidence(matches.length === 1, 'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED');
        const local = evidence.orders.find(row => row.id === matches[0].order_id);
        const at = invoice.status_transitions?.paid_at;
        requireEvidence(local && (matches[0].object_type === 'payment') === isCard(local), 'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED');
        requireEvidence(local.subscription_id === subscription.id && scopeMatches(local, order)
          && local.amount_total !== null && local.amount_total + recordedTax(local, invoice.id) === invoice.amount_paid
          && local.currency === invoice.currency
          && Number.isSafeInteger(at) && at! > 0, 'PAY_REFUND_INVOICE_MISMATCH');
        invoices.push({ id: invoice.id, orderId: local.id, paidAt: new Date(at! * 1000).toISOString(),
          billingReason: invoice.billing_reason });
      }
      if (!result.has_more) { complete = true; break; }
      const next = result.data.at(-1)?.id;
      requireEvidence(next && next !== cursor, 'PAY_REFUND_PROVIDER_HISTORY_INCOMPLETE');
      cursor = next;
    }
    requireEvidence(complete, 'PAY_REFUND_PROVIDER_HISTORY_INCOMPLETE');
  }
  // No missing mapping, legacy paid row, unfulfilled or ambiguous purchase may
  // disappear because a current subscription list happens to look empty.
  for (const local of evidence.orders.filter(row => tookMoney(row, evidence.refs))) {
    requireEvidence(local.user_id === order.user_id && scopeMatches(local, order)
      && invoices.filter(invoice => invoice.orderId === local.id).length === 1,
    'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED');
  }
  return invoices.sort((a, b) => a.id.localeCompare(b.id));
}
async function providerFacts(db: PreviewDb, stripe: SubscriptionRefundStripe, evidence: SubscriptionRefundEvidence, order: PreviewOrder) {
  const scope = await resolveStripeScope(stripe);
  requireEvidence(scope.mode === order.payment_mode && scope.merchant === order.merchant_namespace, 'PAY_REFUND_SCOPE_MISMATCH');
  const live = scope.mode === 'live';
  const invoices = await readInvoiceHistory(stripe, evidence, order);
  const invoice = invoices.find(row => row.orderId === order.id);
  requireEvidence(invoice, 'PAY_REFUND_INVOICE_MISSING');
  // Subscription Checkout does not necessarily persist a PaymentIntent ref.
  // The immutable original invoice ref and its authoritative payment bind cash.
  const taxMinor = recordedTax(order, invoice.id);
  const charged = order.amount_total! + taxMinor;
  const payments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 100 });
  requireEvidence(payments.has_more === false && payments.data.length === 1, 'PAY_REFUND_INVOICE_PAYMENT_UNRESOLVED');
  const payment = payments.data[0];
  const intentId = objectId(payment.payment.payment_intent);
  requireEvidence(payment.object === 'invoice_payment' && payment.livemode === live && payment.status === 'paid'
    && objectId(payment.invoice) === invoice.id && payment.payment.type === 'payment_intent' && intentId
    && payment.amount_paid === charged && payment.currency === order.currency
    && Number.isSafeInteger(payment.status_transitions?.paid_at), 'PAY_REFUND_INVOICE_PAYMENT_MISMATCH');
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = objectId(intent.latest_charge);
  requireEvidence(intent.id === intentId && intent.livemode === live && intent.status === 'succeeded'
    && intent.amount_received === charged && intent.currency === order.currency && chargeId,
  'PAY_REFUND_PAYMENT_MISMATCH');
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  const balance = charge.balance_transaction;
  requireEvidence(charge.id === chargeId && charge.livemode === live && charge.paid === true && charge.captured === true
    && objectId(charge.payment_intent) === intentId && charge.amount === charged
    && charge.amount_captured === charged && charge.currency === order.currency
    && balance && typeof balance !== 'string' && Number.isSafeInteger(balance.created), 'PAY_REFUND_CHARGE_MISMATCH');
  const refunds = await stripe.refunds.list({ charge: chargeId, limit: 1 });
  requireEvidence(refunds.has_more === false && refunds.data.length === 0 && charge.amount_refunded === 0
    && await disputeAllowsRefund(db, stripe, scope, order.id, charge), 'PAY_REFUND_PRIOR_REFUND_OR_DISPUTE');
  // paidMinor is the pre-tax basis of the refund and its fee; a card order's tax (0 for a mainland card) is refunded in full.
  const cash = { paymentIntentId: intentId, chargeId, paidMinor: order.amount_total!, currency: order.currency,
    paidAt: new Date(balance.created * 1000).toISOString(), ...(isCard(order) ? { taxMinor } : {}) };
  // Different payment/capture times are ambiguous for the 168-hour boundary.
  requireEvidence(new Date(payment.status_transitions.paid_at! * 1000).toISOString() === cash.paidAt
    && invoice.paidAt === cash.paidAt, 'PAY_REFUND_PAYMENT_TIME_UNRESOLVED');
  return { cash, invoices, paymentId: payment.id };
}
function consumption(evidence: SubscriptionRefundEvidence, paidAt: string, observedAt: string) {
  const settled = new Set(evidence.holds.filter(row => ['settle', 'refund', 'abort_settle'].includes(row.operation_type))
    .map(row => row.pre_deduct_id));
  const pending = evidence.holds.some(row => row.operation_type === 'pre_deduct' && !settled.has(row.id));
  return assembleRefundConsumption({ userId: evidence.subject.id, paidAt, observedAt,
    evidenceRef: hash([evidence.ledger, evidence.holds]), completeAccountHistory: true,
    settlementState: pending ? 'pending' : 'clear',
    rows: evidence.ledger.map(row => ({ id: row.id, user_id: row.user_id, created_at: row.created_at,
      amount: row.amount, type: row.type, ledger_type: row.ledger_type, reason_code: row.reason_code,
      source_type: row.source_type, idempotency_key: row.idempotency_key, counts_as_spend: row.counts_as_spend })),
  });
}
function verifyGrants(evidence: SubscriptionRefundEvidence, order: PreviewOrder) {
  const grants = evidence.grants.filter(row => row.source_order_id === order.id);
  requireEvidence(grants.length > 0, 'PAY_REFUND_GRANTS_UNRESOLVED');
  for (const grant of grants) {
    requireEvidence(grant.user_id === order.user_id && grant.subscription_id === order.subscription_id
      && grant.status === 'granted' && grant.credits_granted > 0 && grant.credit_transaction_id,
    'PAY_REFUND_GRANTS_UNRESOLVED');
    const snapshot = freezePurchaseSnapshot(grant.grant_snapshot);
    requireEvidence(hash(snapshot) === hash(freezePurchaseSnapshot(order.purchase_snapshot)), 'PAY_REFUND_GRANTS_UNRESOLVED');
    const tx = evidence.ledger.find(row => row.id === grant.credit_transaction_id);
    requireEvidence(tx && tx.source_order_id === order.id && tx.ledger_type === 'grant'
      && Number(tx.amount) === grant.credits_granted, 'PAY_REFUND_GRANTS_UNRESOLVED');
  }
}

/** A read-only advisory preview, never a lock, approval token or cash permission.
 * No provider/DB mutations, no persistent new identity, no dependency on private text.
 * Caller supplies an existing authenticated admin and server-created connections.
 */
export async function readSubscriptionRefundFacts(
  db: PreviewDb, stripe: SubscriptionRefundStripe, actorId: string, input: SubscriptionRefundPreviewRequest,
  approved?: { id: string; versionHash: string; approvedBy: string },
) {
    requireEvidence(input.feeEvidence.trim().length > 0 && input.feeEvidence.length <= 160, 'PAY_REFUND_FEE_EVIDENCE_REQUIRED');
    const order = await readPreviewOrder(db, input.orderId);
    if (approved) {
      const { data, error } = await db.from('payment_orders').select('refund_approval').eq('id', order.id).single();
      const i = data?.refund_approval;
      requireEvidence(!error && i?.kind === 'monthly_first_purchase' && i.status === 'approved'
        && i.id === approved.id && i.versionHash === approved.versionHash, 'PAY_REFUND_STALE_APPROVAL');
      verifyOrder({ ...order, refund_status: null });
    } else verifyOrder(order);
    const first = await readSubscriptionRefundEvidence(db, actorId, order, input.ticketId);
    requireEvidence(hash(first.orders.find(row => row.id === order.id)) === hash(order), 'PAY_REFUND_EVIDENCE_CHANGED');
    verifyGrants(first, order);
    const provider = await providerFacts(db, stripe, first, order);
    const again = await providerFacts(db, stripe, first, order);
    requireEvidence(hash(provider) === hash(again), 'PAY_REFUND_EVIDENCE_CHANGED');
    const last = await readSubscriptionRefundEvidence(db, actorId, order, input.ticketId);
    requireEvidence(hash(first) === hash(last), 'PAY_REFUND_EVIDENCE_CHANGED');
    const observedAt = new Date().toISOString();
    const paidAt = provider.cash.paidAt;
    const target = provider.invoices.find(row => row.orderId === order.id)!;
    const other = provider.invoices.filter(row => row.orderId !== order.id);
    const paid = refundTime(paidAt)!;
    requireEvidence(other.every(row => refundTime(row.paidAt) !== paid), 'PAY_REFUND_PAYMENT_ORDER_UNRESOLVED');
    const spend = consumption(last, paidAt, observedAt);
    requireEvidence(spend, 'PAY_REFUND_CONSUMPTION_UNRESOLVED');
    const kind = target.billingReason === 'subscription_create' && !order.source_order_id ? 'membership_first'
      : target.billingReason === 'subscription_cycle' ? 'renewal' : 'unknown';
    const policy: RefundPolicyInput = {
      order: { id: order.id, userId: order.user_id, channel: 'stripe', mode: order.payment_mode as 'test' | 'live',
        merchant: order.merchant_namespace!,
        currency: order.currency, paidAt, paidMinor: provider.cash.paidMinor, refundedMinor: 0,
        paymentEvidenceRef: hash(provider), kind, refundState: 'none' },
      ticket: { id: last.ticket.id, userId: last.ticket.user_id, orderId: order.id,
        submittedAt: last.ticket.created_at, bindingEvidenceRef: hash([last.ticket, order.id, approved?.approvedBy ?? actorId]) },
      membershipHistory: { userId: order.user_id, orderId: order.id, paidAt, complete: true,
        priorPaidMembershipCount: other.filter(row => refundTime(row.paidAt)! < paid).length,
        evidenceRef: hash(provider.invoices) },
      consumption: spend, observedAt, accountState: 'active', feePermitted: input.feePermitted, reason: 'ordinary',
    };
    return { policy, order, evidence: last, provider };
}

export async function previewSubscriptionRefund(
  db: PreviewDb, stripe: SubscriptionRefundStripe, actorId: string, input: SubscriptionRefundPreviewRequest,
): Promise<RefundPolicyResult> {
  try { return evaluateRefundPolicy((await readSubscriptionRefundFacts(db, stripe, actorId, input)).policy); }
  catch { return review('subscription_evidence_requires_review'); }
}
