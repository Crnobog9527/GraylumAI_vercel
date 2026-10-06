/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export const CUTOFF = '2026-09-23T00:00:00.000Z';
export const CLOSE_REASON = 'stripe_checkout_expired';
const absent = value => value === null;
const objectId = value => typeof value === 'string' ? value : value?.id;
const deny = code => { throw new Error(code); };

export function assertLegacyOrder(order) {
  if (order.payment_channel !== null || order.payment_status !== 'unpaid'
    || order.item_type !== 'membership_plan' || order.mode !== 'subscription'
    || !['monthly', 'yearly'].includes(order.billing_cycle)
    || !order.user_id || !order.stripe_checkout_session_id || !order.stripe_price_id
    || !Number.isFinite(Date.parse(order.created_at)) || Date.parse(order.created_at) >= Date.parse(CUTOFF)
    || !Number.isSafeInteger(order.amount_total) || order.amount_total <= 0
    || !/^[a-z]{3}$/.test(order.currency ?? '')
    || !['stripe_invoice_id', 'stripe_subscription_id', 'subscription_id', 'source_order_id',
      'fulfilled_at', 'payment_amount_facts', 'purchase_action', 'purchase_snapshot',
      'merchant_namespace', 'payment_mode', 'purchase_request_id'].every(key => absent(order[key]))
    || order.has_related_facts !== false) deny('LOCAL_FACTS_UNRESOLVED');
  const closed = order.status === 'expired' && order.purchase_closed_at
    && order.purchase_close_reason === CLOSE_REASON && order.purchase_close_ref === order.stripe_checkout_session_id;
  const pending = order.status === 'pending' && order.purchase_closed_at === null
    && order.purchase_close_reason === null && order.purchase_close_ref === null;
  if (!closed && !pending) deny('LOCAL_FACTS_UNRESOLVED');
  return Boolean(closed);
}

// Only GET requests through the authenticated SDK. No expire/cancel/refund/create calls.
// The pre-PAY-COMMON metadata did not contain orderId; the stored unique session ID,
// owner, product, price, cadence, amount and mode must all match instead.
export async function verifyLegacyCheckout(stripe, order, scope) {
  assertLegacyOrder(order);
  if (!['test', 'live'].includes(scope.mode)) deny('PROVIDER_SCOPE_MISMATCH');
  const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
  if (session.object !== 'checkout.session' || session.id !== order.stripe_checkout_session_id
    || !session.id.startsWith(`cs_${scope.mode}_`) || session.livemode !== (scope.mode === 'live')
    || session.mode !== 'subscription' || session.client_reference_id !== order.user_id
    || session.metadata?.userId !== order.user_id || session.metadata?.itemId !== order.item_id
    || session.metadata?.itemType !== order.item_type || session.metadata?.billingCycle !== order.billing_cycle
    || session.metadata?.priceId !== order.stripe_price_id
    || (session.metadata?.orderId !== undefined && session.metadata.orderId !== order.id)
    || session.amount_total !== order.amount_total || session.currency !== order.currency
    || (order.stripe_customer_id !== null && objectId(session.customer) !== order.stripe_customer_id)
    || session.customer === undefined) deny('PROVIDER_IDENTITY_MISMATCH');
  if (session.status !== 'expired' || session.payment_status !== 'unpaid'
    || !Number.isSafeInteger(session.expires_at) || session.expires_at > Math.floor(Date.now() / 1000)
    || !absent(session.subscription) || !absent(session.invoice)
    || !absent(session.payment_intent) || !absent(session.setup_intent)
    || !absent(session.after_expiration)) {
    deny('PROVIDER_FACTS_UNRESOLVED');
  }
  // Conservative: a customer with any invoice/subscription requires manual reconciliation.
  // An empty complete page is proof; errors, omissions or truncated pages are not.
  if (session.customer !== null) {
    const customer = objectId(session.customer);
    if (!customer || !/^cus_[A-Za-z0-9]+$/.test(customer)) deny('PROVIDER_IDENTITY_MISMATCH');
    for (const list of [
      () => stripe.subscriptions.list({ customer, status: 'all', limit: 1 }),
      () => stripe.invoices.list({ customer, limit: 1 }),
    ]) {
      const result = await list();
      if (result.object !== 'list' || result.has_more !== false || !Array.isArray(result.data)
        || result.data.length !== 0) deny('CUSTOMER_FACTS_UNRESOLVED');
    }
  }
  return session;
}
