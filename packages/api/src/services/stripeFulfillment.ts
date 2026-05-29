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
  refundOrderLookup: 'Failed to look up refunded payment order',
  reconcileRefund: 'Failed to reconcile Stripe refund',
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
      /\b(?:cs_(?:test|live)|sub|in|cus|price|pi|ch|re|evt)_[A-Za-z0-9_]+\b/g,
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

function getObjectId(value: { id?: string | null } | string | null | undefined) {
  if (typeof value === 'string') {
    return value;
  }

  return value?.id ?? null;
}

function getCheckoutSessionPaymentIntentId(session: Stripe.Checkout.Session) {
  return getObjectId(session.payment_intent as { id?: string | null } | string | null | undefined);
}

function getChargeInvoiceId(charge: Stripe.Charge) {
  const chargeRecord = charge as Stripe.Charge & {
    invoice?: string | Stripe.Invoice | null;
  };

  return getObjectId(chargeRecord.invoice);
}

function getMetadataString(
  metadata: Stripe.Metadata | null | undefined,
  keys: string[],
) {
  if (!metadata) {
    return null;
  }

  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getFirstMetadataString(
  metadataSources: Array<Stripe.Metadata | null | undefined>,
  keys: string[],
) {
  for (const metadata of metadataSources) {
    const value = getMetadataString(metadata, keys);
    if (value) {
      return value;
    }
  }

  return null;
}

function isUuid(value: string | null | undefined) {
  return Boolean(value?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i));
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
  const paymentIntentId = getCheckoutSessionPaymentIntentId(session);
  const subscriptionId = getCheckoutSessionSubscriptionId(session);
  const orderMetadata = {
    ...metadata,
    checkoutSessionId: session.id,
    ...(paymentIntentId ? { paymentIntentId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
  };
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
    stripe_subscription_id: subscriptionId,
    stripe_price_id: metadata.priceId ?? null,
    amount_total: session.amount_total,
    currency: session.currency ?? 'usd',
    mode: session.mode,
    status: session.payment_status === 'paid' ? 'completed' : 'pending',
    payment_status: session.payment_status ?? null,
    metadata: orderMetadata,
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

type RefundReconciliationEventType =
  | 'charge.refunded'
  | 'charge.refund.updated'
  | 'refund.created'
  | 'refund.updated'
  | 'refund.failed';

type RefundReconciliationInput =
  | {
      eventId?: string | null;
      eventType: 'charge.refunded';
      charge: Stripe.Charge;
    }
  | {
      eventId?: string | null;
      eventType: Exclude<RefundReconciliationEventType, 'charge.refunded'>;
      refund: Stripe.Refund;
    };

type RefundPaymentOrder = {
  id: string;
  amount_total: number | string | null;
  metadata: Record<string, unknown> | null;
};

type RefundFacts = {
  amountRefunded: number | null;
  chargeId: string | null;
  checkoutSessionId: string | null;
  currency: string | null;
  eventId: string | null;
  eventType: RefundReconciliationEventType;
  failed: boolean;
  forceFullRefund: boolean;
  invoiceId: string | null;
  orderId: string | null;
  paymentIntentId: string | null;
  reason: string | null;
  refundCreatedAt: string | null;
  refundId: string | null;
  refundStatus: string | null;
  subscriptionId: string | null;
};

function getLatestChargeRefund(charge: Stripe.Charge) {
  return charge.refunds?.data?.[0] ?? null;
}

function buildChargeRefundFacts(input: Extract<RefundReconciliationInput, { charge: Stripe.Charge }>): RefundFacts {
  const charge = input.charge;
  const latestRefund = getLatestChargeRefund(charge);
  const metadataSources = [latestRefund?.metadata, charge.metadata];
  const refundId = latestRefund?.id ?? null;
  const amountRefunded = charge.amount_refunded ?? null;

  return {
    amountRefunded,
    chargeId: charge.id,
    checkoutSessionId: getFirstMetadataString(metadataSources, ['checkoutSessionId', 'stripeCheckoutSessionId', 'stripe_checkout_session_id']),
    currency: charge.currency ?? null,
    eventId: input.eventId ?? null,
    eventType: input.eventType,
    failed: false,
    forceFullRefund: Boolean(charge.refunded || (amountRefunded !== null && amountRefunded >= charge.amount)),
    invoiceId: getChargeInvoiceId(charge)
      ?? getFirstMetadataString(metadataSources, ['invoiceId', 'stripeInvoiceId', 'stripe_invoice_id']),
    orderId: getFirstMetadataString(metadataSources, ['paymentOrderId', 'orderId', 'payment_order_id']),
    paymentIntentId: getObjectId(charge.payment_intent)
      ?? getFirstMetadataString(metadataSources, ['paymentIntentId', 'stripePaymentIntentId', 'payment_intent_id']),
    reason: latestRefund?.reason ?? getFirstMetadataString(metadataSources, ['refundReason', 'reason']),
    refundCreatedAt: asIsoTimestamp(latestRefund?.created ?? charge.created),
    refundId,
    refundStatus: latestRefund?.status ?? (charge.refunded ? 'succeeded' : null),
    subscriptionId: getFirstMetadataString(metadataSources, ['subscriptionId', 'stripeSubscriptionId', 'stripe_subscription_id']),
  };
}

function buildRefundFacts(input: Extract<RefundReconciliationInput, { refund: Stripe.Refund }>): RefundFacts {
  const refund = input.refund;
  const expandedCharge = typeof refund.charge === 'object' ? refund.charge : null;
  const metadataSources = [refund.metadata, expandedCharge?.metadata];

  return {
    amountRefunded: refund.amount ?? null,
    chargeId: getObjectId(refund.charge),
    checkoutSessionId: getFirstMetadataString(metadataSources, ['checkoutSessionId', 'stripeCheckoutSessionId', 'stripe_checkout_session_id']),
    currency: refund.currency ?? null,
    eventId: input.eventId ?? null,
    eventType: input.eventType,
    failed: input.eventType === 'refund.failed' || refund.status === 'failed',
    forceFullRefund: Boolean(expandedCharge?.refunded || (expandedCharge && refund.amount >= expandedCharge.amount)),
    invoiceId: (expandedCharge ? getChargeInvoiceId(expandedCharge) : null)
      ?? getFirstMetadataString(metadataSources, ['invoiceId', 'stripeInvoiceId', 'stripe_invoice_id']),
    orderId: getFirstMetadataString(metadataSources, ['paymentOrderId', 'orderId', 'payment_order_id']),
    paymentIntentId: getObjectId(refund.payment_intent)
      ?? getObjectId(expandedCharge?.payment_intent)
      ?? getFirstMetadataString(metadataSources, ['paymentIntentId', 'stripePaymentIntentId', 'payment_intent_id']),
    reason: refund.failure_reason ?? refund.reason ?? getFirstMetadataString(metadataSources, ['refundReason', 'reason']),
    refundCreatedAt: asIsoTimestamp(refund.created),
    refundId: refund.id,
    refundStatus: refund.status ?? null,
    subscriptionId: getFirstMetadataString(metadataSources, ['subscriptionId', 'stripeSubscriptionId', 'stripe_subscription_id']),
  };
}

function buildRefundIdempotencyKey(facts: RefundFacts) {
  if (facts.refundId) {
    return `stripe_refund:${facts.refundId}`;
  }

  if (facts.chargeId) {
    return `stripe_charge_refund:${facts.chargeId}:${facts.amountRefunded ?? 0}`;
  }

  if (facts.eventId) {
    return `stripe_refund_event:${facts.eventId}`;
  }

  return `stripe_refund_order:${facts.eventType}:${facts.amountRefunded ?? 0}`;
}

async function maybeFindRefundOrder(
  queryName: string,
  buildQuery: () => Promise<{ data?: RefundPaymentOrder | null; error?: unknown }>,
  safeContext: Record<string, unknown>,
) {
  const result = await buildQuery();

  if (result.error) {
    throwFulfillmentError(
      `refund_order_lookup_${queryName}`,
      STRIPE_FULFILLMENT_ERRORS.refundOrderLookup,
      result.error,
      safeContext,
    );
  }

  return result.data ?? null;
}

async function findRefundPaymentOrder(
  supabase: SupabaseLikeClient,
  facts: RefundFacts,
): Promise<RefundPaymentOrder | null> {
  const safeContext = {
    refundId: maskIdentifier(facts.refundId),
    chargeId: maskIdentifier(facts.chargeId),
    invoiceId: maskIdentifier(facts.invoiceId),
    paymentIntentId: maskIdentifier(facts.paymentIntentId),
    checkoutSessionId: maskIdentifier(facts.checkoutSessionId),
  };

  if (isUuid(facts.orderId)) {
    const order = await maybeFindRefundOrder(
      'order_id',
      () => supabase
        .from('payment_orders')
        .select('id, amount_total, metadata')
        .eq('id', facts.orderId)
        .maybeSingle(),
      safeContext,
    );
    if (order) return order;
  }

  if (facts.invoiceId) {
    const order = await maybeFindRefundOrder(
      'invoice_id',
      () => supabase
        .from('payment_orders')
        .select('id, amount_total, metadata')
        .eq('stripe_invoice_id', facts.invoiceId)
        .maybeSingle(),
      safeContext,
    );
    if (order) return order;
  }

  if (facts.checkoutSessionId) {
    const order = await maybeFindRefundOrder(
      'checkout_session_id',
      () => supabase
        .from('payment_orders')
        .select('id, amount_total, metadata')
        .eq('stripe_checkout_session_id', facts.checkoutSessionId)
        .maybeSingle(),
      safeContext,
    );
    if (order) return order;
  }

  if (facts.paymentIntentId) {
    const order = await maybeFindRefundOrder(
      'payment_intent_id',
      () => supabase
        .from('payment_orders')
        .select('id, amount_total, metadata')
        .eq('metadata->>paymentIntentId', facts.paymentIntentId)
        .maybeSingle(),
      safeContext,
    );
    if (order) return order;
  }

  if (facts.chargeId) {
    const order = await maybeFindRefundOrder(
      'charge_id',
      () => supabase
        .from('payment_orders')
        .select('id, amount_total, metadata')
        .eq('metadata->>chargeId', facts.chargeId)
        .maybeSingle(),
      safeContext,
    );
    if (order) return order;
  }

  return null;
}

function isFullRefundForOrder(facts: RefundFacts, order: RefundPaymentOrder) {
  if (facts.failed) {
    return false;
  }

  if (facts.forceFullRefund) {
    return true;
  }

  const orderAmount = Number(order.amount_total ?? 0);
  return Number.isFinite(orderAmount)
    && orderAmount > 0
    && facts.amountRefunded !== null
    && facts.amountRefunded >= orderAmount
    && (facts.refundStatus === null || facts.refundStatus === 'succeeded');
}

export async function reconcileStripeRefund(
  supabase: SupabaseLikeClient,
  input: RefundReconciliationInput,
) {
  const facts = 'charge' in input ? buildChargeRefundFacts(input) : buildRefundFacts(input);
  const order = await findRefundPaymentOrder(supabase, facts);

  if (!order) {
    logger.warn('billing', 'stripe_refund_order_not_found', {
      eventType: facts.eventType,
      refundId: maskIdentifier(facts.refundId),
      chargeId: maskIdentifier(facts.chargeId),
      invoiceId: maskIdentifier(facts.invoiceId),
      paymentIntentId: maskIdentifier(facts.paymentIntentId),
      checkoutSessionId: maskIdentifier(facts.checkoutSessionId),
    });
    return null;
  }

  const isFullRefund = isFullRefundForOrder(facts, order);
  const idempotencyKey = buildRefundIdempotencyKey(facts);
  const { data, error } = await supabase.rpc('atomic_reconcile_stripe_refund', {
    p_charge_id: facts.chargeId,
    p_idempotency_key: idempotencyKey,
    p_invoice_id: facts.invoiceId,
    p_is_failed: facts.failed,
    p_is_full_refund: isFullRefund,
    p_order_id: order.id,
    p_payment_intent_id: facts.paymentIntentId,
    p_refund_amount: facts.amountRefunded,
    p_refund_created_at: facts.refundCreatedAt,
    p_refund_currency: facts.currency,
    p_refund_event_type: facts.eventType,
    p_refund_id: facts.refundId,
    p_refund_reason: facts.reason,
    p_refund_status: facts.refundStatus,
    p_subscription_id: facts.subscriptionId,
  });

  if (error) {
    throwFulfillmentError(
      'reconcile_stripe_refund_rpc',
      STRIPE_FULFILLMENT_ERRORS.reconcileRefund,
      error,
      {
        eventType: facts.eventType,
        refundId: maskIdentifier(facts.refundId),
        chargeId: maskIdentifier(facts.chargeId),
        orderId: maskIdentifier(order.id),
      },
    );
  }

  return getFirstRpcRow(data);
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
