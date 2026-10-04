/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Synthetic migration of legacy test fixtures only. Production must never infer mappings this way.
// Freeze once at fixture construction so later catalog edits cannot change purchased terms.
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
export const paymentFixtureScope = { merchant: 'acct_fixture', mode: 'test' as const };
export function seedPaymentCommonFixture(tables: Tables) {
  const refs = tables.payment_provider_refs ??= [];
  const scope = { payment_channel: 'stripe', merchant_namespace: paymentFixtureScope.merchant, payment_mode: 'test' };
  const bind = (kind: string, external: unknown, target: Row) => {
    if (typeof external !== 'string' || !external || external.startsWith('change_subscription_plan_lock:')) return null;
    let ref = refs.find(row => row.object_type === kind && row.external_id === external);
    if (!ref) {
      ref = { id: `fixture-ref-${refs.length + 1}`, channel: 'stripe', merchant_namespace: scope.merchant_namespace,
        mode: 'test', object_type: kind, external_id: external, ...target };
      refs.push(ref);
    }
    return ref.id;
  };
  for (const sub of tables.user_subscriptions ?? []) {
    Object.assign(sub, scope, { ...sub });
    bind('subscription', sub.stripe_subscription_id, { subscription_id: sub.id });
  }
  for (const order of tables.payment_orders ?? []) {
    const plan = (tables.membership_plans ?? []).find(row => row.id === order.item_id);
    const cycle = order.billing_cycle ?? 'monthly';
    const priceId = order.stripe_price_id ?? `price_fixture_${String(order.item_id)}_${String(cycle)}`;
    Object.assign(order, scope, { ...order });
    order.price_ref_id ??= bind('price', priceId, { membership_plan_id: order.item_id, billing_cycle: cycle, is_current: true });
    order.purchase_action ??= typeof order.stripe_checkout_session_id === 'string'
      && order.stripe_checkout_session_id.startsWith('change_subscription_plan_lock:') ? 'subscription_change' : 'checkout';
    order.subscription_id ??= (tables.user_subscriptions ?? []).find(row => row.stripe_subscription_id === order.stripe_subscription_id)?.id ?? null;
    order.purchase_membership_level ??= plan?.level ?? 'pro';
    if (plan && !order.purchase_snapshot) {
      order.purchase_snapshot = { version: 1, item_type: 'membership_plan', item_id: order.item_id,
        item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: cycle, currency: 'usd', unit: 'major',
        price: (Number(order.amount_total ?? plan[cycle === 'yearly' ? 'yearly_price' : 'monthly_price'] ?? 1999) / 100).toFixed(2),
        discount: '0.00', tax_behavior: 'unspecified',
        credits: Number(plan[cycle === 'yearly' ? 'yearly_credits' : 'monthly_credits'] ?? 0),
        bonus_credits: cycle === 'yearly' ? 0 : Number(plan.monthly_bonus_credits ?? 0) };
    }
    bind('checkout', order.stripe_checkout_session_id, { order_id: order.id });
    bind('invoice', order.stripe_invoice_id, { order_id: order.id });
  }
  for (const grant of tables.subscription_credit_grants ?? []) {
    const sub = (tables.user_subscriptions ?? []).find(row => row.stripe_subscription_id === grant.stripe_subscription_id);
    const order = (tables.payment_orders ?? []).find(row => row.stripe_invoice_id === grant.stripe_invoice_id);
    grant.subscription_id ??= sub?.id ?? null;
    grant.source_order_id ??= order?.id ?? null;
    grant.grant_snapshot ??= order?.purchase_snapshot ?? null;
  }
}
