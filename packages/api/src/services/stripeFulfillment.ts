/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';
import { logger } from '../lib/logger';

type SupabaseLikeClient = any;
const STRIPE_FULFILLMENT_ERRORS = {
  checkoutOrderLookup: 'Failed to look up checkout order',
  checkoutOrderUpdate: 'Failed to update checkout order from session',
  checkoutOrderInsert: 'Failed to insert checkout order from session',
  missingCheckoutMetadata: 'Checkout session is missing fulfillment metadata',
  creditOrderLookup: 'Failed to look up credit package order',
  backfillCheckoutOrder: 'Failed to backfill checkout order fulfillment',
  fulfillCreditPackage: 'Failed to fulfill credit package order',
  missingCreditFulfilledAt: 'Atomic credit fulfillment returned no fulfilled_at',
  invoiceSubscriptionMissing: 'Stripe invoice is missing subscription id',
  invoiceOrderLookup: 'Failed to look up invoice payment order',
  fulfillMembershipInvoice: 'Failed to fulfill membership invoice',
  missingMembershipFulfilledAt: 'Atomic membership fulfillment returned no fulfilled_at',
  subscriptionLookup: 'Failed to look up subscription state',
  subscriptionUpdate: 'Failed to update subscription state',
  canceledProfileDowngrade: 'Failed to downgrade canceled subscription profile',
} as const;

class StripeFulfillmentError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    public readonly safeContext: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StripeFulfillmentError';
  }
}

function getFirstRpcRow<T>(data: T[] | null | undefined): T | null {
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function asIsoTimestamp(value: number | null | undefined) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function maskIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function maskKnownIdentifiers(message: string | null | undefined) {
  if (!message) {
    return null;
  }

  return message
    .replace(
      /\b(?:cs_(?:test|live)|sub|in|cus|price|pi|ch)_[A-Za-z0-9_]+\b/g,
      (value) => maskIdentifier(value) ?? value,
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (value) => maskIdentifier(value) ?? value,
    );
}

function summarizeSupabaseError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      code: null,
      message: typeof error === 'string' ? maskKnownIdentifiers(error.slice(0, 240)) : null,
      details: null,
      hint: null,
    };
  }

  const errorRecord = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };

  return {
    code: typeof errorRecord.code === 'string' ? errorRecord.code : null,
    message: typeof errorRecord.message === 'string'
      ? maskKnownIdentifiers(errorRecord.message.slice(0, 240))
      : null,
    details: typeof errorRecord.details === 'string'
      ? maskKnownIdentifiers(errorRecord.details.slice(0, 240))
      : null,
    hint: typeof errorRecord.hint === 'string'
      ? maskKnownIdentifiers(errorRecord.hint.slice(0, 240))
      : null,
  };
}

function throwFulfillmentError(
  stage: string,
  message: string,
  cause: unknown,
  context: Record<string, unknown> = {},
): never {
  const safeContext = {
    ...context,
    supabaseError: summarizeSupabaseError(cause),
  };

  logger.error('billing', 'stripe_fulfillment_stage_failed', {
    stage,
    ...safeContext,
  });

  throw new StripeFulfillmentError(stage, message, safeContext, { cause });
}

function getCheckoutSessionSubscriptionId(session: Stripe.Checkout.Session) {
  return typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice) {
  const invoiceRecord = invoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
    subscription_details?: {
      subscription?: string | Stripe.Subscription | null;
    } | null;
  };
  const candidates = [
    invoice.parent?.subscription_details?.subscription,
    invoiceRecord.subscription,
    invoiceRecord.subscription_details?.subscription,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }

    if (candidate && typeof candidate === 'object' && 'id' in candidate) {
      return candidate.id ?? null;
    }
  }

  return null;
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
    throwFulfillmentError(
      'backfill_checkout_order',
      STRIPE_FULFILLMENT_ERRORS.backfillCheckoutOrder,
      result.error,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
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

  if (existing.error) {
    throwFulfillmentError(
      'upsert_payment_order_lookup',
      STRIPE_FULFILLMENT_ERRORS.checkoutOrderLookup,
      existing.error,
      { checkoutSessionId: maskIdentifier(session.id) },
    );
  }

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
    const result = await supabase
      .from('payment_orders')
      .update(payload)
      .eq('id', existing.data.id);

    if (result.error) {
      throwFulfillmentError(
        'upsert_payment_order_update',
        STRIPE_FULFILLMENT_ERRORS.checkoutOrderUpdate,
        result.error,
        {
          checkoutSessionId: maskIdentifier(session.id),
          subscriptionId: maskIdentifier(payload.stripe_subscription_id),
          orderId: maskIdentifier(existing.data.id),
        },
      );
    }

    return;
  }

  if (!payload.user_id || !payload.item_type || !payload.item_id) {
    throwFulfillmentError(
      'upsert_payment_order_metadata',
      STRIPE_FULFILLMENT_ERRORS.missingCheckoutMetadata,
      new Error('missing checkout session metadata'),
      {
        checkoutSessionId: maskIdentifier(session.id),
        hasUserId: Boolean(payload.user_id),
        hasItemType: Boolean(payload.item_type),
        hasItemId: Boolean(payload.item_id),
      },
    );
  }

  const result = await supabase.from('payment_orders').insert(payload);
  if (result.error) {
    throwFulfillmentError(
      'upsert_payment_order_insert',
      STRIPE_FULFILLMENT_ERRORS.checkoutOrderInsert,
      result.error,
      {
        checkoutSessionId: maskIdentifier(session.id),
        subscriptionId: maskIdentifier(payload.stripe_subscription_id),
      },
    );
  }
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

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from('payment_orders')
    .select('id, fulfilled_at')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();

  if (existingOrderError) {
    throwFulfillmentError(
      'credit_order_lookup',
      STRIPE_FULFILLMENT_ERRORS.creditOrderLookup,
      existingOrderError,
      { checkoutSessionId: maskIdentifier(session.id) },
    );
  }

  if (existingOrder?.fulfilled_at) {
    return;
  }

  const { data, error } = await supabase.rpc('atomic_fulfill_credit_package', {
    p_checkout_session_id: session.id,
    p_payment_status: session.payment_status ?? 'paid',
  });

  if (error) {
    throwFulfillmentError(
      'fulfill_credit_package_rpc',
      STRIPE_FULFILLMENT_ERRORS.fulfillCreditPackage,
      error,
      { checkoutSessionId: maskIdentifier(session.id) },
    );
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
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  const invoiceId = invoice.id;

  if (!subscriptionId) {
    throwFulfillmentError(
      'invoice_subscription_parse',
      STRIPE_FULFILLMENT_ERRORS.invoiceSubscriptionMissing,
      new Error('invoice subscription id missing'),
      { invoiceId: maskIdentifier(invoiceId) },
    );
  }

  const { data: existingInvoiceOrder, error: existingInvoiceOrderError } = await supabase
    .from('payment_orders')
    .select('id, fulfilled_at')
    .eq('stripe_invoice_id', invoiceId)
    .maybeSingle();

  if (existingInvoiceOrderError) {
    throwFulfillmentError(
      'invoice_order_lookup',
      STRIPE_FULFILLMENT_ERRORS.invoiceOrderLookup,
      existingInvoiceOrderError,
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
  }

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
    throwFulfillmentError(
      'fulfill_membership_invoice_rpc',
      STRIPE_FULFILLMENT_ERRORS.fulfillMembershipInvoice,
      error,
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
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

  const { data: existingSubscription, error: existingSubscriptionError } = await supabase
    .from('user_subscriptions')
    .select('user_id, membership_plan_id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();

  if (existingSubscriptionError) {
    throwFulfillmentError(
      'subscription_state_lookup',
      STRIPE_FULFILLMENT_ERRORS.subscriptionLookup,
      existingSubscriptionError,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  const updateResult = await supabase
    .from('user_subscriptions')
    .update({
      status: subscription.status,
      cancel_at_period_end: cancelAtPeriodEnd,
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscriptionId);

  if (updateResult.error) {
    throwFulfillmentError(
      'subscription_state_update',
      STRIPE_FULFILLMENT_ERRORS.subscriptionUpdate,
      updateResult.error,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  if (subscription.status === 'canceled' && existingSubscription?.user_id) {
    const profileResult = await supabase
      .from('profiles')
      .update({ membership_level: 'free' })
      .eq('id', existingSubscription.user_id);

    if (profileResult.error) {
      throwFulfillmentError(
        'subscription_canceled_profile_update',
        STRIPE_FULFILLMENT_ERRORS.canceledProfileDowngrade,
        profileResult.error,
        { subscriptionId: maskIdentifier(subscriptionId) },
      );
    }
  }
}
