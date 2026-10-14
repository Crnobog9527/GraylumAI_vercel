/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GRAYLUM_INITIATED_CANCEL } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';

/** "Stopped" means no further renewal: cancel_at_period_end, or a cancel_at exactly at the current paid-period end
 * (a later cancel_at still renews in between, so it is not a stop). */
export function stripeStopState(subscription: Stripe.Subscription) {
  const item = subscription.items?.data?.length === 1 ? subscription.items.data[0] : null;
  const stopAtEnd = subscription.cancel_at_period_end === true
    || (subscription.cancel_at !== null && item !== null && subscription.cancel_at === item.current_period_end);
  return { stop: stopAtEnd, canceled: subscription.status === 'canceled' || subscription.status === 'incomplete_expired' };
}

export async function readSubscription(stripe: Stripe, subscriptionId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.object !== 'subscription' || subscription.id !== subscriptionId || subscription.livemode) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  return subscription;
}

export async function syncState(db: SupabaseClient, merchant: string, localSubscriptionId: string, subscription: Stripe.Subscription) {
  const state = stripeStopState(subscription);
  // Only a cancellation the buyer asked for ends the founder renewal window; retry exhaustion does not.
  const result = await db.rpc('pay_stripe_mp_sync_subscription', { p_subscription: localSubscriptionId, p_merchant: merchant,
    p_cancel_at_period_end: state.stop, p_canceled: state.canceled,
    p_user_canceled: state.canceled && subscription.cancellation_details?.reason === 'cancellation_requested'
      && subscription.cancellation_details?.comment !== GRAYLUM_INITIATED_CANCEL });
  if (result.error) throw new Error('PAY_STRIPE_MP_RENEWAL_UNAVAILABLE', { cause: result.error });
  return state;
}

/** A first card subscription payment kept for review (not delivered: e.g. an upgrade paid after its cutoff, a closed
 * account) has no local subscription row yet, so nothing else would stop it: stop its renewal at Stripe (marked
 * Graylum-initiated) and confirm, so the customer is never charged again for a membership they did not receive. The
 * paid first period is left to the review (refund). A failure throws so the payment webhook is retried. */
export async function stopUndeliveredSubscription(stripe: Stripe, subscriptionId: string) {
  let subscription = await readSubscription(stripe, subscriptionId);
  if (!stripeStopState(subscription).stop && !stripeStopState(subscription).canceled) {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true,
      cancellation_details: { comment: GRAYLUM_INITIATED_CANCEL } });
    subscription = await readSubscription(stripe, subscriptionId);
  }
  const state = stripeStopState(subscription);
  if (!state.stop && !state.canceled) throw new Error('PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED');
}

/** A renewal kept for review (closed or erasing account, stopped credit release, canceled locally) must not charge
 * again: stop renewal at Stripe and confirm before acknowledging. A failure throws so Stripe retries the event; the
 * renewal is deduplicated by invoice, so the retry only repeats this stop. */
export async function stopRenewalAfterReview(db: SupabaseClient, stripe: Stripe, merchant: string, localSubscriptionId: string,
  subscriptionId: string) {
  let subscription = await readSubscription(stripe, subscriptionId);
  if (!stripeStopState(subscription).stop && !stripeStopState(subscription).canceled) {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true,
      cancellation_details: { comment: GRAYLUM_INITIATED_CANCEL } });
    subscription = await readSubscription(stripe, subscriptionId);
  }
  const state = await syncState(db, merchant, localSubscriptionId, subscription);
  if (!state.stop && !state.canceled) throw new Error('PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED');
}

