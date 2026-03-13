/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';

type SupabaseLikeClient = any;

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
    throw new Error(result.error.message);
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

  const [{ data: creditPackage, error: packageError }, { data: profile, error: profileError }] =
    await Promise.all([
      supabase
        .from('credit_packages')
        .select('id, name, credits_amount, bonus_credits')
        .eq('id', packageId)
        .single(),
      supabase.from('profiles').select('credits').eq('id', userId).single(),
    ]);

  if (packageError || !creditPackage) {
    throw new Error(`Credit package not found for checkout session ${session.id}`);
  }

  if (profileError || !profile) {
    throw new Error(`Profile not found for credit package checkout session ${session.id}`);
  }

  const totalCredits = (creditPackage.credits_amount ?? 0) + (creditPackage.bonus_credits ?? 0);
  const updatedCredits = (profile.credits ?? 0) + totalCredits;
  const fulfilledAt = new Date().toISOString();

  const [profileUpdate, transactionInsert, orderUpdate] = await Promise.all([
    supabase
      .from('profiles')
      .update({ credits: updatedCredits })
      .eq('id', userId),
    supabase.from('credit_transactions').insert({
      user_id: userId,
      amount: totalCredits,
      type: 'purchase',
      description: `Stripe 购买积分包: ${creditPackage.name}`,
    }),
    supabase
      .from('payment_orders')
      .update({
        status: 'completed',
        payment_status: session.payment_status ?? 'paid',
        fulfilled_at: fulfilledAt,
        updated_at: fulfilledAt,
      })
      .eq('stripe_checkout_session_id', session.id),
  ]);

  if (profileUpdate.error) throw new Error(profileUpdate.error.message);
  if (transactionInsert.error) throw new Error(transactionInsert.error.message);
  if (orderUpdate.error) throw new Error(orderUpdate.error.message);
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

  const { data: sessionOrder, error: sessionOrderError } = await supabase
    .from('payment_orders')
    .select('id, user_id, item_id, billing_cycle, stripe_customer_id, stripe_price_id')
    .eq('stripe_subscription_id', subscriptionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sessionOrderError || !sessionOrder?.user_id || !sessionOrder.item_id) {
    throw new Error(`Subscription order not found for invoice ${invoiceId}`);
  }

  const { data: plan, error: planError } = await supabase
    .from('membership_plans')
    .select('id, name, level, monthly_credits, yearly_credits, monthly_bonus_credits')
    .eq('id', sessionOrder.item_id)
    .single();

  if (planError || !plan) {
    throw new Error(`Membership plan not found for invoice ${invoiceId}`);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', sessionOrder.user_id)
    .single();

  if (profileError || !profile) {
    throw new Error(`Profile not found for subscription invoice ${invoiceId}`);
  }

  const billingCycle = sessionOrder.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  const grantedCredits =
    billingCycle === 'yearly'
      ? (plan.yearly_credits ?? 0)
      : (plan.monthly_credits ?? 0) + (plan.monthly_bonus_credits ?? 0);
  const fulfilledAt = new Date().toISOString();
  const nextCredits = (profile.credits ?? 0) + grantedCredits;

  if (existingInvoiceOrder?.id) {
    await supabase
      .from('payment_orders')
      .update({
        user_id: sessionOrder.user_id,
        item_type: 'membership_plan',
        item_id: plan.id,
        billing_cycle: billingCycle,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id:
          sessionOrder.stripe_customer_id ??
          (typeof invoice.customer === 'string' ? invoice.customer : null),
        stripe_price_id: sessionOrder.stripe_price_id ?? null,
        amount_total: invoice.amount_paid,
        currency: invoice.currency ?? 'usd',
        mode: 'subscription',
        status: 'completed',
        payment_status: 'paid',
        fulfilled_at: fulfilledAt,
        updated_at: fulfilledAt,
      })
      .eq('id', existingInvoiceOrder.id);
  } else {
    await supabase
      .from('payment_orders')
      .insert({
        user_id: sessionOrder.user_id,
        item_type: 'membership_plan',
        item_id: plan.id,
        billing_cycle: billingCycle,
        stripe_invoice_id: invoiceId,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id:
          sessionOrder.stripe_customer_id ??
          (typeof invoice.customer === 'string' ? invoice.customer : null),
        stripe_price_id: sessionOrder.stripe_price_id ?? null,
        amount_total: invoice.amount_paid,
        currency: invoice.currency ?? 'usd',
        mode: 'subscription',
        status: 'completed',
        payment_status: 'paid',
        fulfilled_at: fulfilledAt,
        metadata: {
          source: 'invoice.payment_succeeded',
        },
      });
  }

  const [profileUpdate, transactionInsert, subscriptionUpsert] = await Promise.all([
    supabase
      .from('profiles')
      .update({
        membership_level: plan.level,
        credits: nextCredits,
      })
      .eq('id', sessionOrder.user_id),
    supabase.from('credit_transactions').insert({
      user_id: sessionOrder.user_id,
      amount: grantedCredits,
      type: 'addition',
      description: `Stripe 会员积分到账: ${plan.name} (${billingCycle === 'yearly' ? '年付' : '月付'})`,
    }),
    supabase.from('user_subscriptions').upsert(
      {
        user_id: sessionOrder.user_id,
        membership_plan_id: plan.id,
        stripe_customer_id:
          sessionOrder.stripe_customer_id ??
          (typeof invoice.customer === 'string' ? invoice.customer : null),
        stripe_subscription_id: subscriptionId,
        stripe_price_id: sessionOrder.stripe_price_id ?? null,
        billing_cycle: billingCycle,
        status: invoice.status ?? 'paid',
        cancel_at_period_end: 'false',
        current_period_start: asIsoTimestamp(invoice.period_start),
        current_period_end: asIsoTimestamp(invoice.period_end),
        metadata: {
          lastInvoiceId: invoiceId,
        },
        updated_at: fulfilledAt,
      },
      {
        onConflict: 'stripe_subscription_id',
      },
    ),
  ]);

  if (profileUpdate.error) throw new Error(profileUpdate.error.message);
  if (transactionInsert.error) throw new Error(transactionInsert.error.message);
  if (subscriptionUpsert.error) throw new Error(subscriptionUpsert.error.message);

  await backfillCheckoutOrderFulfillment(supabase, subscriptionId, fulfilledAt);
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
