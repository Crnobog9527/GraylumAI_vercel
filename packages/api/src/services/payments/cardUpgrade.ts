/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { readSubscription, stopRenewalAfterReview, stripeStopState, syncState } from './cardSubscriptionStop';
import type { StripeScope } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';
import { MethodPurchaseRejected } from './methodPurchaseError';

/** PAY-STRIPE-MP step 4a: Pro -> Gold upgrade of a card subscription (#847 section 3). The upgrade is a new Gold
 * checkout (`transition: 'upgrade'`); once Gold is paid the Pro stops at period end. Stripe's in-place upgrade is never
 * used, so the Pro term stays intact and a refunded Gold falls back to it (0243 settles the level). */

/** The Stripe subscription of a card (Managed Payments / mainland) subscription, or null for any other kind. */
export async function cardStripeSubscription(db: Pick<SupabaseClient, 'from'>, scope: StripeScope, localId: string) {
  const [sub, ref] = await Promise.all([
    db.from('user_subscriptions').select('stripe_subscription_id,payment_channel').eq('id', localId).maybeSingle(),
    db.from('payment_provider_refs').select('external_id').eq('subscription_id', localId).eq('object_type', 'subscription')
      .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).limit(2),
  ]);
  if (sub.error || ref.error || !Array.isArray(ref.data) || ref.data.length > 1) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
  const row = sub.data as { stripe_subscription_id: string | null; payment_channel: string | null } | null;
  if (!row || row.payment_channel !== 'stripe' || row.stripe_subscription_id) return null;
  return (ref.data[0]?.external_id as string | undefined) ?? null;
}

/** Before the upgrade checkout: admission (0222) admits a renewing prior only when the provider was seen renewing
 * within 5 minutes. Read the Pro at Stripe now; when it still renews, record the observation (0251); otherwise copy
 * its state, and admission refuses with its usual "wait" answer. A still-renewing prior of another kind (Waffo, legacy
 * Stripe) is refused: after the Gold is paid nothing here could stop it at its own provider, so it could charge again. */
export async function observeUpgradePrior(db: SupabaseClient, stripe: Stripe, userId: string, priorLocalId: string) {
  const scope = await resolveStripeScope(stripe);
  const stripeId = await cardStripeSubscription(db, scope, priorLocalId);
  if (!stripeId) {
    const prior = await db.from('user_subscriptions').select('user_id,cancel_at_period_end').eq('id', priorLocalId).maybeSingle();
    if (prior.error) throw new Error('PAY_COMMON_MAPPING_READ_FAILED', { cause: prior.error });
    const row = prior.data as { user_id: string; cancel_at_period_end: string | boolean | null } | null;
    // Another user's or unknown prior: admission refuses it with its usual answer.
    if (row?.user_id === userId && String(row.cancel_at_period_end) !== 'true') {
      throw new MethodPurchaseRejected('PAY_STRIPE_MP_UPGRADE_PRIOR_CHANNEL');
    }
    return;
  }
  const subscription = await readSubscription(stripe, stripeId);
  if (subscription.metadata?.userId !== userId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const state = stripeStopState(subscription);
  if (subscription.status !== 'active' || state.stop || state.canceled) {
    await syncState(db, scope.merchant, priorLocalId, subscription);
    // Refused here, not left to admission: a positive observation from a minute ago (0251) could still admit it while
    // an unpaid Pro invoice (past_due) can retry and charge.
    throw new MethodPurchaseRejected('PAY_WAFFO_UPGRADE_WAIT');
  }
  const observed = await db.rpc('pay_stripe_mp_observe_subscription', { p_subscription: priorLocalId, p_merchant: scope.merchant });
  if (observed.error) throw new Error('PAY_STRIPE_MP_RENEWAL_UNAVAILABLE', { cause: observed.error });
}

/** After a delivered upgrade payment: stop the prior card subscription at period end at Stripe, read it back and copy
 * the stop (marked Graylum-initiated). A failure throws so the payment webhook is retried; the delivery itself is
 * idempotent, so a retry only repeats this stop. */
export async function stopPriorAfterUpgrade(db: SupabaseClient, stripe: Stripe,
  order: { method_transition?: string | null; method_prior_subscription?: string | null }) {
  if (order.method_transition !== 'upgrade' || !order.method_prior_subscription) return;
  const scope = await resolveStripeScope(stripe);
  const stripeId = await cardStripeSubscription(db, scope, order.method_prior_subscription);
  if (stripeId) await stopRenewalAfterReview(db, stripe, scope.merchant, order.method_prior_subscription, stripeId);
}
