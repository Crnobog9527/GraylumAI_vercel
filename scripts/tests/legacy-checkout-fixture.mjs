/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export function fixture() {
  const order = { id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222',
    item_id: '33333333-3333-4333-8333-333333333333', item_type: 'membership_plan', billing_cycle: 'monthly',
    mode: 'subscription', stripe_checkout_session_id: 'cs_test_fixture', stripe_price_id: 'price_fixture',
    stripe_customer_id: 'cus_fixture', amount_total: 990, currency: 'usd', created_at: '2026-09-22T12:00:00Z',
    status: 'pending', payment_status: 'unpaid', has_related_facts: false };
  for (const key of ['payment_channel', 'merchant_namespace', 'payment_mode', 'purchase_action', 'purchase_snapshot',
    'purchase_request_id', 'stripe_invoice_id', 'stripe_subscription_id', 'subscription_id', 'source_order_id',
    'fulfilled_at', 'payment_amount_facts', 'purchase_closed_at', 'purchase_close_reason', 'purchase_close_ref']) order[key] = null;
  const session = { object: 'checkout.session', id: order.stripe_checkout_session_id, livemode: false,
    mode: 'subscription', client_reference_id: order.user_id, amount_total: 990, currency: 'usd', customer: 'cus_fixture',
    status: 'expired', payment_status: 'unpaid', expires_at: 1790080000,
    subscription: null, invoice: null, payment_intent: null, setup_intent: null, after_expiration: null,
    metadata: { userId: order.user_id, itemId: order.item_id, itemType: order.item_type,
      billingCycle: order.billing_cycle, priceId: order.stripe_price_id } };
  const calls = [];
  const empty = { object: 'list', has_more: false, data: [] };
  const stripe = { checkout: { sessions: { retrieve: async () => { calls.push('retrieve'); return structuredClone(session); } } },
    subscriptions: { list: async () => { calls.push('subscriptions'); return structuredClone(empty); } },
    invoices: { list: async () => { calls.push('invoices'); return structuredClone(empty); } } };
  return { order, session, stripe, calls, empty, scope: { merchant: 'acct_fixture', mode: 'test' } };
}
