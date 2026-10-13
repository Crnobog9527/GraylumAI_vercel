/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { recoverMethodCheckout } from './walletWebhook';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
type CardSubscriptionOrder = { id: string; user_id: string; payment_method: string };

/** The PAY-STRIPE-MP card order behind a Stripe subscription, or null for any other subscription (legacy
 * D17 subscriptions keep their own path). Decided from our mapping or the authenticated subscription's
 * metadata, never from event payload fields. */
async function findCardOrder(db: SupabaseClient, stripe: Stripe, scope: { merchant: string; mode: string },
  subscriptionId: string): Promise<CardSubscriptionOrder | null> {
  const ref = await db.from('payment_provider_refs').select('subscription_id').eq('channel', 'stripe')
    .eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).eq('object_type', 'subscription')
    .eq('external_id', subscriptionId).maybeSingle();
  if (ref.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const query = db.from('payment_orders').select('id,user_id,payment_method').in('payment_method', ['card', 'card_cn']);
  if (ref.data?.subscription_id) {
    const mapped = await query.eq('subscription_id', ref.data.subscription_id).eq('purchase_action', 'checkout')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (mapped.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
    return mapped.data;
  }
  // Not mapped yet: the first invoice can arrive before checkout completion is recorded.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const orderId = subscription.metadata?.orderId;
  if (subscription.object !== 'subscription' || subscription.id !== subscriptionId || !orderId
    || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const order = await query.eq('id', orderId).maybeSingle();
  if (order.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (order.data && order.data.user_id !== subscription.metadata?.userId) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  return order.data;
}

/** The Checkout Session that created this order's subscription: our mapping first, else a scoped search. */
async function orderCheckoutSession(db: SupabaseClient, stripe: Stripe, scope: { merchant: string; mode: string },
  order: CardSubscriptionOrder, subscriptionId: string) {
  const ref = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id).eq('object_type', 'checkout')
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).maybeSingle();
  if (ref.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (ref.data?.external_id) return ref.data.external_id as string;
  const sessions = await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 10 });
  const matches = sessions.data.filter(session => session.metadata?.orderId === order.id);
  if (matches.length !== 1 || sessions.has_more) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  return matches[0]!.id;
}

/** Invoice events of PAY-STRIPE-MP card subscriptions. Returns false for any other invoice.
 * The first invoice (subscription_create) only confirms the first payment through the same idempotent
 * fulfillment as checkout completion, so the two events grant once in any order. Renewals, failures and
 * other invoices are handled in a later step; until then they are refused (the card gate is closed). */
export async function handleCardSubscriptionInvoice(db: SupabaseClient, stripe: Stripe, invoiceId: string, eventType: string) {
  const scope = await resolveStripeScope(stripe);
  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.object !== 'invoice' || invoice.id !== invoiceId) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  const subscriptionId = id(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return false;
  const order = await findCardOrder(db, stripe, scope, subscriptionId);
  if (!order) return false;
  if ((eventType === 'invoice.paid' || eventType === 'invoice.payment_succeeded') && invoice.billing_reason === 'subscription_create') {
    await recoverMethodCheckout(db, stripe, await orderCheckoutSession(db, stripe, scope, order, subscriptionId), eventType);
    return true;
  }
  throw new Error('PAY_STRIPE_MP_CARD_SUBSCRIPTION_NOT_READY');
}

/** customer.subscription.* of PAY-STRIPE-MP card subscriptions: state sync is a later step (refused until
 * then; the card gate is closed). Returns false for any other subscription. */
export async function handleCardSubscriptionState(db: SupabaseClient, stripe: Stripe, subscriptionId: string) {
  const scope = await resolveStripeScope(stripe);
  if (!await findCardOrder(db, stripe, scope, subscriptionId)) return false;
  throw new Error('PAY_STRIPE_MP_CARD_SUBSCRIPTION_NOT_READY');
}
