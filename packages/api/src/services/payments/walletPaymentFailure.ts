/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { recoverMethodCheckout } from './walletWebhook';
import type { DisputeAlert } from './disputes';

/** The signed event is a wake-up only. A current original PI locates the scoped, persisted checkout;
 * recovery re-reads that session and its PI before recording a failure or delivering a subsequent success. */
export async function recoverWalletPaymentFailure(db: SupabaseClient, stripe: Stripe, paymentIntentId: string,
  disputeAlert?: DisputeAlert) {
  const scope = await resolveStripeScope(stripe);
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (intent.object !== 'payment_intent' || intent.id !== paymentIntentId || intent.livemode !== (scope.mode === 'live')) {
    throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  }
  if (intent.status !== 'requires_payment_method' || !intent.last_payment_error || intent.amount_received !== 0) return false;
  const orderId = intent.metadata.orderId;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return false;
  const original = await db.from('payment_orders').select('payment_method,payment_channel,merchant_namespace,payment_mode')
    .eq('id', orderId).maybeSingle();
  if (original.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (!original.data || !['wechat_pay', 'alipay'].includes(original.data.payment_method)) return false;
  if (original.data.payment_channel !== 'stripe' || original.data.merchant_namespace !== scope.merchant
    || original.data.payment_mode !== scope.mode) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  const ref = await db.from('payment_provider_refs').select('external_id').eq('order_id', orderId)
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).eq('object_type', 'checkout').maybeSingle();
  if (ref.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (!ref.data?.external_id) return false;
  const session = await stripe.checkout.sessions.retrieve(ref.data.external_id);
  const sessionIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (session.object !== 'checkout.session' || session.id !== ref.data.external_id || sessionIntent !== intent.id) {
    throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  }
  return Boolean(await recoverMethodCheckout(db, stripe, session.id, 'payment_intent.payment_failed', disputeAlert));
}
