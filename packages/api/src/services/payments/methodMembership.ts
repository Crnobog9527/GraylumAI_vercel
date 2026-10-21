/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPaymentMethodRoutes } from './methodRouting';
import { isStagingPaymentDeployment, methodCheckoutMethods, methodCheckoutReady } from './methodCheckoutGate';
import { readFounderStatus } from '../founder/member';

type PaidMembership = { id: string; subscription_id: string; purchase_membership_level: string; payment_method: string;
  payment_channel: string; auto_renew: boolean | null; entitlement_start: string; entitlement_end: string; offer_kind: string;
  billing_cycle: string };
type SubscriptionState = { id: string; status: string; cancel_at_period_end: string | boolean | null;
  method_cancel_requested_at: string | null; method_cancel_confirmed_at: string | null };
const GRACE_MS = 24 * 3600 * 1000;

/** Read-only member-page projection. Orders remain the authority for paid access; a pending
 * checkout or provider subscription status alone cannot grant membership. Founder capacity is
 * shared across merchants/methods in the same mode, matching 0204's atomic reservation. */
export async function readMethodMembership(db: SupabaseClient, userId: string, now = Date.now(),
  env: Record<string, string | undefined> = process.env, mode: 'test' | 'live' = 'test') {
  // R7 (0296): the Stripe account's mode (live in production); founder seats are counted per mode like admission.
  const [routes, orders, founderOrders] = await Promise.all([
    readPaymentMethodRoutes(db),
    db.from('payment_orders').select([
      'id', 'subscription_id', 'purchase_membership_level', 'payment_method', 'payment_channel', 'auto_renew',
      'entitlement_start', 'entitlement_end', 'offer_kind', 'billing_cycle',
    ].join(',')).eq('user_id', userId).eq('payment_mode', mode)
      .eq('item_type', 'membership_plan').eq('qualification_state', 'sold')
      .eq('payment_status', 'paid').eq('status', 'completed').not('fulfilled_at', 'is', null)
      // Also the last 24 hours: a still-renewing card subscription keeps access in its renewal grace (0214/0238).
      .gt('entitlement_end', new Date(now - GRACE_MS).toISOString()).order('entitlement_start', { ascending: true }).limit(100),
    // One statement/snapshot: separately reading sold and reserved can double-count a
    // reservation that becomes sold between reads, or temporarily understate occupied slots.
    db.from('payment_orders').select('qualification_state')
      .eq('payment_mode', mode).eq('offer_kind', 'founder')
      .or('qualification_state.in.(sold,reserved),and(qualification_state.eq.review,qualification_closed_ref.is.null)')
      .limit(51),
  ]);
  if (orders.error || founderOrders.error || !Array.isArray(orders.data) || !Array.isArray(founderOrders.data)
    || founderOrders.data.some(row => !['sold', 'reserved', 'review'].includes(row.qualification_state))) {
    throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  }
  // auto_renew on the order is what was bought; a confirmed stop (methodCancel) only flips the
  // subscription's cancel_at_period_end, the same flag getEntitlements reads. Report the effective value.
  const candidates = orders.data as unknown as PaidMembership[];
  const holds = candidates.length ? await db.from('payment_disputes').select('order_id')
    .in('order_id', candidates.map(row => row.id)).eq('freeze_state', 'frozen') : { data: [], error: null };
  if (holds.error || !Array.isArray(holds.data)) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  const frozen = new Set(holds.data.map(row => row.order_id as string));
  const recent = candidates.filter(row => !frozen.has(row.id));
  const subscriptionIds = [...new Set(recent.map(row => row.subscription_id).filter(Boolean))];
  const subscriptions = subscriptionIds.length === 0 ? { data: [], error: null }
    : await db.from('user_subscriptions').select('id,status,cancel_at_period_end,method_cancel_requested_at,method_cancel_confirmed_at')
      .eq('user_id', userId).in('id', subscriptionIds);
  if (subscriptions.error || !Array.isArray(subscriptions.data)) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  const states = new Map((subscriptions.data as SubscriptionState[]).map(row => [row.id, row]));
  if (recent.some(row => !states.has(row.subscription_id))) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  const stopped = (row: PaidMembership) => String(states.get(row.subscription_id)!.cancel_at_period_end) === 'true';
  // Same rule as pay_common_membership_facts: the latest paid term of a still-renewing card subscription (Waffo card,
  // Stripe card / card_cn) keeps access for 24 hours after its end while the renewal payment lands. Display only.
  const inGrace = (row: PaidMembership) => {
    const state = states.get(row.subscription_id)!;
    return Date.parse(row.entitlement_end) <= now
      && (row.payment_channel === 'waffo' && row.payment_method === 'card'
        || row.payment_channel === 'stripe' && ['card', 'card_cn'].includes(row.payment_method))
      && row.auto_renew === true && state.status === 'active' && !stopped(row)
      && !state.method_cancel_requested_at && !state.method_cancel_confirmed_at
      && !recent.some(later => later.subscription_id === row.subscription_id && later.id !== row.id
        && Date.parse(later.entitlement_end) > Date.parse(row.entitlement_end));
  };
  const paid = recent.filter(row => Date.parse(row.entitlement_end) > now || inGrace(row));
  const memberships = paid.map(row => ({ ...row, cancel_at_period_end: stopped(row),
    auto_renew: row.auto_renew === true && !stopped(row), inGrace: inGrace(row) }));
  // For the purchase entry (PAY-STRIPE-MP step 5): the published terms version methodCheckout requires, and whether
  // the Gold first-month offer applies. The latter is display only: pay_waffo_admit_purchase decides at checkout,
  // also against other accounts of the same person (identity digests), which this read cannot see.
  // Gold as 0222 admission counts it: orders before 0170 have no purchase_membership_level, only metadata or the plan.
  const [terms, plans] = await Promise.all([
    db.from('system_settings').select('value').eq('key', 'payment_terms_version').maybeSingle(),
    db.from('membership_plans').select('id').eq('level', 'gold').limit(20),
  ]);
  if (!terms || terms.error || !plans || plans.error || !Array.isArray(plans.data)) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  const goldPlans = plans.data.map(row => String(row.id));
  const isGold = ['purchase_membership_level.eq.gold', 'metadata->>membershipLevel.eq.gold',
    ...(goldPlans.length ? [`item_id.in.(${goldPlans.join(',')})`] : [])].join(',');
  const gold = await db.from('payment_orders').select('id').eq('user_id', userId).eq('payment_mode', mode)
    .or(`and(or(${isGold}),or(payment_status.in.(paid,refunded,partially_refunded),fulfilled_at.not.is.null))`).limit(1);
  if (!gold || gold.error || !Array.isArray(gold.data)) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  const version = (terms.data as { value?: { version?: unknown } } | null)?.value?.version;
  // Historical sold slots never return to the pool, including refunds and cancellation.
  const occupied = founderOrders.data.length;
  const sold = founderOrders.data.filter(row => row.qualification_state === 'sold').length;
  if (occupied > 50) throw new Error('PAY_WAFFO_FOUNDER_CAPACITY_CONFLICT');
  const checkoutMethods = methodCheckoutMethods(env, routes);
  let founderRenewal: { itemId: string; subscriptionId: string; eligibleUntil: string } | null = null;
  // Wallet founders renew manually. Project the already-approved 7-day renewal window on the exact
  // staging deployment; the checkout admission RPC remains the authority when the button is used.
  if (mode === 'test' && isStagingPaymentDeployment(env)
    && checkoutMethods.some(method => method === 'wechat_pay' || method === 'alipay')) {
    const status = await readFounderStatus(db, userId);
    if ((status.state === 'active' || status.state === 'grace') && status.orderId) {
      const source = await db.from('payment_orders').select('item_id,subscription_id,payment_method,payment_channel,offer_kind')
        .eq('id', status.orderId).eq('user_id', userId).eq('payment_mode', mode)
        .eq('status', 'completed').eq('payment_status', 'paid').eq('qualification_state', 'sold')
        .not('fulfilled_at', 'is', null).maybeSingle();
      if (source.error) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
      const order = source.data as { item_id?: unknown; subscription_id?: unknown; payment_method?: unknown;
        payment_channel?: unknown; offer_kind?: unknown } | null;
      if (order && ['wechat_pay', 'alipay'].includes(String(order.payment_method)) && order.payment_channel === 'stripe'
        && ['founder', 'founder_renewal'].includes(String(order.offer_kind))
        && typeof order.item_id === 'string' && typeof order.subscription_id === 'string') {
        const deadline = await db.rpc('pay_waffo_founder_deadline', { p_order: status.orderId });
        if (deadline.error) throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
        const eligibleUntil = typeof deadline.data === 'string' ? new Date(deadline.data) : null;
        if (eligibleUntil && Number.isFinite(eligibleUntil.getTime()) && eligibleUntil.getTime() > now) {
          founderRenewal = { itemId: order.item_id, subscriptionId: order.subscription_id, eligibleUntil: eligibleUntil.toISOString() };
        }
      }
    }
  }
  return { mode, routes,
    // Staging wallet routes can also expose the entry; production readiness stays on the card path.
    checkoutReady: methodCheckoutReady(env, routes, undefined, mode),
    checkoutMethods,
    founder: { total: 50, sold, reserved: occupied - sold, available: 50 - occupied },
    memberships, founderRenewal,
    termsVersion: typeof version === 'string' ? version : null,
    goldFirstMonthEligible: gold.data.length === 0,
  };
}
