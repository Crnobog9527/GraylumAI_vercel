/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeScope } from './purchaseFacts';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const OPEN_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];

export type CardPortalSubscription = { localId: string; stripeSubscriptionId: string; orderIds: Set<string> };

/** PAY-STRIPE-MP: the card (Managed Payments / mainland card) subscription "管理订阅 / 取消续费" manages. Card rows
 * carry no stripe_subscription_id or customer; the Stripe subscription is their 'subscription' reference. After an
 * upgrade the stopping Pro and the new Gold are both open: the renewing one is managed (else the latest stopped one,
 * so its renewal can be restored). Returns null when the user has no open card subscription. */
export async function loadCardPortalSubscription(db: Pick<SupabaseClient, 'from'>, userId: string, scope: StripeScope)
  : Promise<CardPortalSubscription | null> {
  const subs = await db.from('user_subscriptions').select('id,cancel_at_period_end,current_period_end')
    .eq('user_id', userId).eq('payment_channel', 'stripe').eq('merchant_namespace', scope.merchant)
    .eq('payment_mode', scope.mode).is('stripe_subscription_id', null).in('status', OPEN_STATUSES).limit(10);
  if (subs.error || !Array.isArray(subs.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
  const candidates: Array<CardPortalSubscription & { renewing: boolean; end: string }> = [];
  for (const sub of subs.data as Array<{ id: string; cancel_at_period_end: string | null; current_period_end: string }>) {
    const [orders, ref] = await Promise.all([
      db.from('payment_orders').select('id').eq('user_id', userId).eq('subscription_id', sub.id)
        .in('payment_method', ['card', 'card_cn']).not('fulfilled_at', 'is', null).limit(100),
      db.from('payment_provider_refs').select('external_id').eq('subscription_id', sub.id).eq('object_type', 'subscription')
        .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).limit(2),
    ]);
    if (orders.error || ref.error || !Array.isArray(orders.data) || !Array.isArray(ref.data) || ref.data.length > 1) {
      throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
    }
    if (!orders.data.length || !ref.data[0]?.external_id) continue;
    candidates.push({ localId: sub.id, stripeSubscriptionId: ref.data[0].external_id, renewing: sub.cancel_at_period_end !== 'true',
      orderIds: new Set(orders.data.map(row => row.id as string)), end: sub.current_period_end });
  }
  const renewing = candidates.filter(c => c.renewing);
  if (renewing.length > 1) throw new Error('PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN');
  // All stopped: never the subscription a delivered upgrade replaced (its renewal must not be restored), even when it
  // ends later (an annual Pro upgraded to a monthly Gold); then the latest-ending of the rest.
  let open = candidates;
  if (!renewing.length && candidates.length > 1) {
    const replaced = await db.from('payment_orders').select('method_prior_subscription').eq('user_id', userId)
      .eq('method_transition', 'upgrade').not('fulfilled_at', 'is', null)
      .in('method_prior_subscription', candidates.map(c => c.localId)).limit(20);
    if (replaced.error || !Array.isArray(replaced.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
    const gone = new Set(replaced.data.map(row => row.method_prior_subscription as string));
    open = candidates.filter(c => !gone.has(c.localId));
  }
  const chosen = renewing[0] ?? open.sort((a, b) => b.end.localeCompare(a.end))[0];
  return chosen ? { localId: chosen.localId, stripeSubscriptionId: chosen.stripeSubscriptionId, orderIds: chosen.orderIds } : null;
}

/** Opens the Stripe customer portal on one subscription, proven to be this user's. Legacy rows store the customer;
 * card rows do not, so the subscription's own customer is used once its metadata (written by our checkout) names this
 * user and one of this subscription's orders. The default portal configuration must cancel at period end only and
 * disable plan changes. A scheduled cancellation opens portal home, where the customer can restore renewal. */
export async function openStripePortal(stripe: Pick<Stripe, 'subscriptions' | 'billingPortal'>, input: {
  subscriptionId: string; userId: string; returnUrl: string; expectedCustomer?: string | null; orderIds?: Set<string>;
}) {
  const remote = await stripe.subscriptions.retrieve(input.subscriptionId);
  const customerId = id(remote.customer);
  const owned = input.expectedCustomer ? customerId === input.expectedCustomer : Boolean(input.orderIds?.has(remote.metadata?.orderId ?? ''));
  if (!customerId || !owned || remote.metadata?.userId !== input.userId) throw new Error('Portal subscription ownership mismatch');
  const configurations = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
  const configuration = configurations.data[0];
  if (!configuration?.active || !configuration.features.subscription_cancel.enabled
    || configuration.features.subscription_cancel.mode !== 'at_period_end' || configuration.features.subscription_update.enabled) {
    throw new Error('Portal configuration must allow period-end cancellation and disable plan changes');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId, configuration: configuration.id, return_url: input.returnUrl,
    flow_data: remote.cancel_at_period_end || remote.cancel_at != null ? undefined : {
      type: 'subscription_cancel', subscription_cancel: { subscription: remote.id },
      after_completion: { type: 'redirect', redirect: { return_url: input.returnUrl } },
    },
  });
  return { portalUrl: session.url };
}
