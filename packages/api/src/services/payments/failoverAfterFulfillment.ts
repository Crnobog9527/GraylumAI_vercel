/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from '../stripe';
import { stopPriorAfterUpgrade, observeUpgradePrior } from './cardUpgrade';

/** Automatic Stripe subscriptions keep their original provider. Never accept an upgrade while
 * its original recurring charge cannot be checked; ordinary emergency purchases do not call Stripe. */
export async function observeFailoverUpgrade(db: SupabaseClient, userId: string, priorId?: string) {
  if (!priorId) throw new Error('PAY_WAFFO_TRANSITION_DENIED');
  const prior = await db.from('user_subscriptions').select('payment_channel,cancel_at_period_end')
    .eq('id', priorId).eq('user_id', userId).maybeSingle();
  if (prior.error || !prior.data) throw new Error('PAY_WAFFO_TRANSITION_DENIED');
  if (prior.data.payment_channel === 'stripe' && String(prior.data.cancel_at_period_end) !== 'true') {
    await observeUpgradePrior(db, getStripeClient({ timeout: 2000, maxNetworkRetries: 0 }), userId, priorId);
  }
}

/** The database durably requests the prior stop in the same transaction as fulfillment.
 * A failed provider stop leaves this receipt retryable and the existing Stripe daily backstop active. */
export async function afterWaffoFulfillment(db: SupabaseClient, orderId: string, deadline?: number) {
  const order = await db.from('payment_orders').select('method_transition,method_prior_subscription')
    .eq('id', orderId).eq('payment_channel', 'waffo').maybeSingle();
  if (order.error || !order.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (order.data.method_transition !== 'upgrade' || !order.data.method_prior_subscription) return;
  const prior = await db.from('user_subscriptions').select('payment_channel,cancel_at_period_end')
    .eq('id', order.data.method_prior_subscription).maybeSingle();
  if (prior.error || !prior.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (prior.data.payment_channel === 'stripe' && String(prior.data.cancel_at_period_end) !== 'true') {
    const remaining = deadline === undefined ? 2000 : Math.min(2000, deadline - Date.now());
    if (remaining <= 0) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    await stopPriorAfterUpgrade(db, getStripeClient({ timeout: remaining, maxNetworkRetries: 0 }), order.data);
  }
}
