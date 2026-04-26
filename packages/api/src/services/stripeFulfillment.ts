/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';

type SupabaseLikeClient = any;
const STRIPE_FULFILLMENT_ERRORS = {
  backfillCheckoutOrder: 'Failed to backfill checkout order fulfillment',
  fulfillCreditPackage: 'Failed to fulfill credit package order',
  missingCreditFulfilledAt: 'Atomic credit fulfillment returned no fulfilled_at',
  fulfillMembershipInvoice: 'Failed to fulfill membership invoice',
  missingMembershipFulfilledAt: 'Atomic membership fulfillment returned no fulfilled_at',
} as const;

function getFirstRpcRow<T>(data: T[] | null | undefined): T | null {
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function asIsoTimestamp(value: number | null | undefined) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function getCheckoutSessionSubscriptionId(session: Stripe.Checkout.Session) {
  return typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null;
}

async function backfillCheckoutOrderFulfillment(
  supabase: SupabaseLikeClient,
  subscriptionId: string,
  fulfilledAt: string,
) {
  const result = await supabase
    .from('payment_orders')
    .update({
      fulfilled_at: fulfilledAt,
      status: 'completed',
      payment_status: 'paid',
      updated_at: fulfilledAt,
    })
    .eq('stripe_subscription_id', subscriptionId)
    .is('stripe_invoice_id', null);

  if (result.error) {
    throw new Error(STRIPE_FULFILLMENT_ERRORS.backfillCheckoutOrder);
  }
}

export async function upsertPaymentOrderBySession(
  supabase: SupabaseLikeClient,
  session: Stripe.Checkout.Session,
) {
  const metadata = session.metadata ?? {};
  const existing = await supabase
    .from('payment_orders')
    .select('id')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();

  const payload = {
    user_id: metadata.userId ?? session.client_reference_id ?? null,
    item_type: metadata.itemType ?? null,
    item_id: metadata.itemId ?? null,
    billing_cycle: metadata.billingCycle ?? 'one_time',
    stripe_checkout_session_id: session.id,
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
    stripe_subscription_id: getCheckoutSessionSubscriptionId(session),
    stripe_price_id: metadata.priceId ?? null,
    amount_total: session.amount_total,
    currency: session.currency ?? 'usd',
    mode: session.mode,
    status: session.payment_status === 'paid' ? 'completed' : 'pending',
    payment_status: session.payment_status ?? null,
    metadata,
    updated_at: new Date().toISOString(),
  };

  if (existing.data?.id) {
    await supabase
      .from('payment_orders')
      .update(payload)
      .eq('id', existing.data.id);
    return;
  }

  if (!payload.user_id || !payload.item_type || !payload.item_id) {
    return;
  }

  await supabase.from('payment_orders').insert(payload);
}

export async function fulfillCreditPackageOrder(
  supabase: SupabaseLikeClient,
  session: Stripe.Checkout.Session,
) {
  const metadata = session.metadata ?? {};
  const userId = metadata.userId ?? session.client_reference_id;
  const packageId = metadata.itemId;

  if (!userId || !packageId || metadata.itemType !== 'credit_package') {
    return;
  }

  const { data: existingOrder } = await supabase
    .from('payment_orders')
    .select('id, fulfilled_at')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();

  if (existingOrder?.fulfilled_at) {
    return;
  }

  const { data, error } = await supabase.rpc('atomic_fulfill_credit_package', {
    p_checkout_session_id: session.id,
    p_payment_status: session.payment_status ?? 'paid',
  });

  if (error) {
    throw new Error(STRIPE_FULFILLMENT_ERRORS.fulfillCreditPackage);
  }

  const result = getFirstRpcRow<{ fulfilled_at?: string | null }>(data);
  if (!result?.fulfilled_at) {
    throw new Error(STRIPE_FULFILLMENT_ERRORS.missingCreditFulfilledAt);
  }
}

export async function fulfillMembershipInvoice(
  supabase: SupabaseLikeClient,
  invoice: Stripe.Invoice,
) {
  const subscriptionRef = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;
  const invoiceId = invoice.id;

  if (!subscriptionId) {
    return;
  }

  const { data: existingInvoiceOrder } = await supabase
    .from('payment_orders')
    .select('id, fulfilled_at')
    .eq('stripe_invoice_id', invoiceId)
    .maybeSingle();

  if (existingInvoiceOrder?.fulfilled_at) {
    await backfillCheckoutOrderFulfillment(
      supabase,
      subscriptionId,
      existingInvoiceOrder.fulfilled_at,
    );
    return;
  }

  const { data, error } = await supabase.rpc('atomic_fulfill_membership_invoice', {
    p_amount_total: invoice.amount_paid,
    p_currency: invoice.currency ?? 'usd',
    p_invoice_id: invoiceId,
    p_payment_status: invoice.status ?? 'paid',
    p_period_end: asIsoTimestamp(invoice.period_end),
    p_period_start: asIsoTimestamp(invoice.period_start),
    p_stripe_customer_id: typeof invoice.customer === 'string' ? invoice.customer : null,
    p_subscription_id: subscriptionId,
  });

  if (error) {
    throw new Error(STRIPE_FULFILLMENT_ERRORS.fulfillMembershipInvoice);
  }

  const result = getFirstRpcRow<{ fulfilled_at?: string | null }>(data);
  if (!result?.fulfilled_at) {
    throw new Error(STRIPE_FULFILLMENT_ERRORS.missingMembershipFulfilledAt);
  }

  await backfillCheckoutOrderFulfillment(supabase, subscriptionId, result.fulfilled_at);
}

export async function syncSubscriptionState(
  supabase: SupabaseLikeClient,
  subscription: Stripe.Subscription,
) {
  const subscriptionId = subscription.id;
  const primaryItem = subscription.items.data[0];
  const currentPeriodStart = asIsoTimestamp(primaryItem?.current_period_start ?? null);
  const currentPeriodEnd = asIsoTimestamp(primaryItem?.current_period_end ?? null);
  const cancelAtPeriodEnd = subscription.cancel_at_period_end ? 'true' : 'false';

  const { data: existingSubscription } = await supabase
    .from('user_subscriptions')
    .select('user_id, membership_plan_id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();

  await supabase
    .from('user_subscriptions')
    .update({
      status: subscription.status,
      cancel_at_period_end: cancelAtPeriodEnd,
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscriptionId);

  if (subscription.status === 'canceled' && existingSubscription?.user_id) {
    await supabase
      .from('profiles')
      .update({ membership_level: 'free' })
      .eq('id', existingSubscription.user_id);
  }
}
