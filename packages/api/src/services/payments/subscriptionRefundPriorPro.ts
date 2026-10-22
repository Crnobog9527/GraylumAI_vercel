/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SubscriptionRefundEvidence, PreviewOrder } from './subscriptionRefundEvidence';
import type { MonthlyRefundTerms } from './monthlyRefundApproval';
import { freezePurchaseSnapshot } from './contracts';

/** Resolve only the recorded Pro -> Gold checkout relationship, never infer it from price or current tier. */
export function subscriptionRefundPriorPro(e: SubscriptionRefundEvidence, o: PreviewOrder): MonthlyRefundTerms['priorPro'] {
  if (!o.source_order_id && o.method_transition !== 'upgrade' && !o.method_prior_subscription) return undefined;
  const fail = () => { throw new Error('PAY_REFUND_UPGRADE_EVIDENCE'); };
  const prior = e.orders.find(row => row.id === o.source_order_id);
  const sub = e.subscriptions.find(row => row.id === o.method_prior_subscription);
  if (o.method_transition !== 'upgrade' || o.purchase_membership_level !== 'gold' || !prior || !sub
    || prior.subscription_id !== sub.id || prior.purchase_membership_level !== 'pro'
    || prior.user_id !== o.user_id || sub.user_id !== o.user_id
    || prior.status !== 'completed' || prior.payment_status !== 'paid' || !prior.fulfilled_at || prior.refund_status
    || prior.payment_channel !== 'stripe' || sub.payment_channel !== 'stripe'
    || prior.payment_mode !== o.payment_mode || sub.payment_mode !== o.payment_mode
    || prior.merchant_namespace !== o.merchant_namespace || sub.merchant_namespace !== o.merchant_namespace
    || !sub.current_period_end || !['active', 'canceled', 'cancelled'].includes(sub.status)
    || sub.status === 'active' && sub.cancel_at_period_end !== 'true') return fail();
  const contract = freezePurchaseSnapshot(sub.contract_snapshot);
  const snapshot = freezePurchaseSnapshot(prior.purchase_snapshot);
  if (JSON.stringify(contract) !== JSON.stringify(snapshot) || !['monthly', 'yearly'].includes(contract.billing_cycle)
    || e.orders.some(row => row.id !== o.id && row.subscription_id !== sub.id
      && (row.fulfilled_at || row.payment_status !== 'unpaid' || row.qualification_state !== 'released'))) return fail();
  const refs = e.refs.filter(row => row.channel === 'stripe' && row.mode === o.payment_mode
    && row.merchant_namespace === o.merchant_namespace);
  const subscriptions = refs.filter(row => row.subscription_id === sub.id && row.object_type === 'subscription');
  const invoices = refs.filter(row => row.order_id === prior.id && row.object_type === 'payment');
  if (subscriptions.length !== 1 || invoices.length !== 1) return fail();
  return { orderId: prior.id, subscriptionId: sub.id, providerSubscriptionId: subscriptions[0].external_id,
    invoiceId: invoices[0].external_id, periodEnd: sub.current_period_end };
}
