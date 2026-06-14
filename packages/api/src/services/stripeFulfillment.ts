/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';
import { logger } from '../lib/logger';
import {
  mergePaymentOrderStatus,
  normalizePaymentOrderStatus,
  resolveCheckoutSessionOrderStatus,
  type PaymentOrderStatusLike,
} from './paymentOrderStatus';
import { getStripeClient } from './stripe';
import {
  fulfillMembershipInvoiceWithSubscriptionCreditGrants,
  reconcileSubscriptionRefundCreditGrants,
} from './subscriptionCreditGrants';
import { isSubscriptionPlanChangeOrder } from './subscriptionPlanChangeLock';

type SupabaseLikeClient = any;
type SubscriptionRefundOrderRow = {
  id?: string | null;
  user_id?: string | null;
  item_type?: string | null;
  billing_cycle?: string | null;
  status?: string | null;
  payment_status?: string | null;
  stripe_invoice_id?: string | null;
  stripe_subscription_id?: string | null;
  amount_total?: number | string | null;
  currency?: string | null;
  metadata?: Record<string, unknown> | null;
};
type StripeRefundWebhookEvent =
  | (Stripe.Event & { type: 'refund.created' | 'refund.updated'; data: { object: Stripe.Refund } })
  | (Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } });

const STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS = 999;
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
  invoicePaymentFailedLookup: 'Failed to look up failed invoice payment order',
  invoicePaymentFailedUpdate: 'Failed to mark invoice payment order failed',
  invoicePaymentFailedInsert: 'Failed to insert failed invoice payment order',
  refundChargeLookup: 'Failed to retrieve Stripe refund charge',
  refundOrderLookup: 'Failed to look up subscription refund order',
  refundReconciliation: 'Failed to reconcile subscription refund credit grants',
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function getInvoicePaymentIntentId(invoice: Stripe.Invoice) {
  const invoiceRecord = invoice as Stripe.Invoice & {
    payment_intent?: string | Stripe.PaymentIntent | null;
  };

  if (typeof invoiceRecord.payment_intent === 'string') {
    return invoiceRecord.payment_intent;
  }

  if (invoiceRecord.payment_intent && typeof invoiceRecord.payment_intent === 'object') {
    return invoiceRecord.payment_intent.id ?? null;
  }

  return null;
}

function getInvoiceCustomerId(invoice: Stripe.Invoice) {
  return typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
}

function getFailedInvoiceAmount(invoice: Stripe.Invoice) {
  return invoice.amount_due ?? invoice.amount_remaining ?? invoice.amount_paid ?? null;
}

function getExpandableId(value: string | { id?: string | null } | null | undefined) {
  if (typeof value === 'string') {
    return value;
  }

  return value?.id ?? null;
}

function toNonNegativeInteger(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(Math.trunc(value), 0);
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 0) : 0;
  }

  return 0;
}

function getChargeInvoiceId(charge: Stripe.Charge | null | undefined) {
  const chargeRecord = charge as (Stripe.Charge & {
    invoice?: string | Stripe.Invoice | null;
  }) | null | undefined;

  return getExpandableId(chargeRecord?.invoice);
}

function getChargePaymentIntentId(charge: Stripe.Charge | null | undefined) {
  return getExpandableId(charge?.payment_intent);
}

function getRefundPaymentIntentId(refund: Stripe.Refund) {
  return getExpandableId(refund.payment_intent);
}

function getRefundCharge(refund: Stripe.Refund) {
  return typeof refund.charge === 'object' && refund.charge !== null
    ? refund.charge as Stripe.Charge
    : null;
}

function getRefundChargeId(refund: Stripe.Refund) {
  return getExpandableId(refund.charge);
}

function getChargeRefundId(charge: Stripe.Charge) {
  const refund = charge.refunds?.data?.[0];
  return refund?.id ?? null;
}

function isSubscriptionRefundOrder(
  order: SubscriptionRefundOrderRow | null,
): order is SubscriptionRefundOrderRow & { id: string; stripe_subscription_id: string } {
  return Boolean(order?.id
    && order.item_type === 'membership_plan'
    && order.stripe_subscription_id);
}

function isFullRefundForOrder(input: {
  amountRefunded: number;
  charge?: Stripe.Charge | null;
  order: SubscriptionRefundOrderRow;
  metadata?: Stripe.Metadata | null;
}) {
  if (input.metadata?.fullRefund === 'true') {
    return true;
  }

  const orderAmount = toNonNegativeInteger(input.order.amount_total);
  if (orderAmount > 0) {
    return input.amountRefunded >= orderAmount;
  }

  const chargeAmount = toNonNegativeInteger(input.charge?.amount);
  const chargeAmountRefunded = toNonNegativeInteger(input.charge?.amount_refunded);
  if (chargeAmount > 0) {
    return chargeAmountRefunded >= chargeAmount || input.amountRefunded >= chargeAmount;
  }

  return input.charge?.refunded === true;
}

async function retrieveStripeCharge(chargeId: string) {
  try {
    return await getStripeClient().charges.retrieve(chargeId, {
      expand: ['invoice'],
    });
  } catch (error) {
    throwFulfillmentError(
      'refund_charge_lookup',
      STRIPE_FULFILLMENT_ERRORS.refundChargeLookup,
      error,
      { chargeId: maskIdentifier(chargeId) },
    );
  }
}

async function resolveRefundCharge(
  refund: Stripe.Refund,
  retrieveCharge: (chargeId: string) => Promise<Stripe.Charge>,
) {
  const expandedCharge = getRefundCharge(refund);
  if (expandedCharge) {
    return expandedCharge;
  }

  const chargeId = getRefundChargeId(refund);
  return chargeId ? retrieveCharge(chargeId) : null;
}

async function getSubscriptionRefundOrderByInvoice(
  supabase: SupabaseLikeClient,
  input: {
    invoiceId: string;
    eventType: string;
  },
): Promise<SubscriptionRefundOrderRow | null> {
  const result = await supabase
    .from('payment_orders')
    .select('id, user_id, item_type, billing_cycle, status, payment_status, stripe_invoice_id, stripe_subscription_id, amount_total, currency, metadata')
    .eq('stripe_invoice_id', input.invoiceId)
    .maybeSingle();

  if (result.error) {
    throwFulfillmentError(
      'refund_order_lookup',
      STRIPE_FULFILLMENT_ERRORS.refundOrderLookup,
      result.error,
      { invoiceId: maskIdentifier(input.invoiceId), eventType: input.eventType },
    );
  }

  return result.data ?? null;
}

async function backfillCheckoutOrderFulfillment(
  supabase: SupabaseLikeClient,
  subscriptionId: string,
  fulfilledAt: string,
) {
  const query = supabase
    .from('payment_orders')
    .update({
      fulfilled_at: fulfilledAt,
      status: 'completed',
      payment_status: 'paid',
      updated_at: fulfilledAt,
    })
    .eq('stripe_subscription_id', subscriptionId)
    .like('stripe_checkout_session_id', 'cs_%')
    .is('stripe_invoice_id', null);
  const result = typeof query.neq === 'function'
    ? await query.neq('status', 'failed')
    : await query;

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
  options: {
    orderStatus?: PaymentOrderStatusLike;
    eventType?: string;
    now?: string;
  } = {},
) {
  const metadata = session.metadata ?? {};
  const existing = await supabase
    .from('payment_orders')
    .select('id, status, fulfilled_at, metadata')
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

  const nextStatus = mergePaymentOrderStatus({
    existingStatus: existing.data?.status,
    fulfilledAt: existing.data?.fulfilled_at,
    nextStatus: resolveCheckoutSessionOrderStatus(session, {
      orderStatus: options.orderStatus,
    }),
  });
  const now = options.now ?? new Date().toISOString();
  const orderMetadata = {
    ...asRecord(existing.data?.metadata),
    ...metadata,
    checkoutStatus: session.status ?? null,
    paymentStatus: session.payment_status ?? null,
    lastPaymentOrderStatus: nextStatus,
    lastPaymentOrderStatusSource: options.eventType ?? 'checkout.session.sync',
    lastPaymentOrderStatusAt: now,
  };

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
    status: nextStatus,
    payment_status: session.payment_status ?? null,
    metadata: orderMetadata,
    updated_at: now,
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

const FAILED_INVOICE_ORDER_SELECT = [
  'id',
  'user_id',
  'item_type',
  'item_id',
  'billing_cycle',
  'stripe_checkout_session_id',
  'stripe_invoice_id',
  'stripe_subscription_id',
  'stripe_customer_id',
  'stripe_price_id',
  'status',
  'fulfilled_at',
  'created_at',
  'metadata',
].join(',');

async function findInvoiceFailureOrders(
  supabase: SupabaseLikeClient,
  invoice: Stripe.Invoice,
  subscriptionId: string | null,
) {
  const invoiceId = invoice.id;
  const existingInvoiceOrder = await supabase
    .from('payment_orders')
    .select(FAILED_INVOICE_ORDER_SELECT)
    .eq('stripe_invoice_id', invoiceId)
    .maybeSingle();

  if (existingInvoiceOrder.error) {
    throwFulfillmentError(
      'invoice_payment_failed_lookup',
      STRIPE_FULFILLMENT_ERRORS.invoicePaymentFailedLookup,
      existingInvoiceOrder.error,
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
  }

  if (existingInvoiceOrder.data?.id || !subscriptionId) {
    return {
      invoiceOrder: existingInvoiceOrder.data ?? null,
      subscriptionOrder: null,
    };
  }

  const sourceCutoff = getFailedInvoiceSourceQueryCutoff(invoice);
  const subscriptionOrderQuery = supabase
    .from('payment_orders')
    .select(FAILED_INVOICE_ORDER_SELECT)
    .eq('stripe_subscription_id', subscriptionId);
  const cutoffSubscriptionOrderQuery = sourceCutoff && typeof subscriptionOrderQuery.lte === 'function'
    ? subscriptionOrderQuery.lte('created_at', sourceCutoff)
    : subscriptionOrderQuery;
  const filteredSubscriptionOrderQuery = typeof cutoffSubscriptionOrderQuery.neq === 'function'
    ? cutoffSubscriptionOrderQuery.neq('status', 'failed')
    : cutoffSubscriptionOrderQuery;
  const orderedSubscriptionOrderQuery = filteredSubscriptionOrderQuery
    .order('created_at', { ascending: false });
  const canApplyLimitBeforeInvoiceFilter = !sourceCutoff || typeof subscriptionOrderQuery.lte === 'function';
  const limitedSubscriptionOrderQuery = canApplyLimitBeforeInvoiceFilter
    && typeof orderedSubscriptionOrderQuery.limit === 'function'
    ? orderedSubscriptionOrderQuery.limit(1)
    : orderedSubscriptionOrderQuery;
  const subscriptionOrder = await limitedSubscriptionOrderQuery.maybeSingle();

  if (subscriptionOrder.error) {
    throwFulfillmentError(
      'invoice_payment_failed_subscription_lookup',
      STRIPE_FULFILLMENT_ERRORS.invoicePaymentFailedLookup,
      subscriptionOrder.error,
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
  }

  return {
    invoiceOrder: null,
    subscriptionOrder: subscriptionOrder.data ?? null,
  };
}

function isPendingCheckoutOrderForFirstInvoice(order: any) {
  return Boolean(order?.id)
    && normalizePaymentOrderStatus(order.status) === 'pending'
    && !order.fulfilled_at
    && !order.stripe_invoice_id;
}

function isCreatedNoLaterThan(
  createdAt: string | null | undefined,
  referenceAt: string | null,
  toleranceMs = 0,
) {
  if (!createdAt || !referenceAt) {
    return false;
  }

  const createdTime = Date.parse(createdAt);
  const referenceTime = Date.parse(referenceAt);

  return Number.isFinite(createdTime)
    && Number.isFinite(referenceTime)
    && createdTime <= referenceTime + toleranceMs;
}

function getFailedInvoiceSourceCutoff(invoice: Stripe.Invoice) {
  return asIsoTimestamp(invoice.created) ?? asIsoTimestamp(invoice.period_start);
}

function getFailedInvoiceSourceQueryCutoff(invoice: Stripe.Invoice) {
  const sourceCutoff = getFailedInvoiceSourceCutoff(invoice);
  if (!sourceCutoff) {
    return null;
  }

  const parsedCutoff = Date.parse(sourceCutoff);
  return Number.isFinite(parsedCutoff)
    ? new Date(parsedCutoff + STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS).toISOString()
    : sourceCutoff;
}

function isSourceOrderKnownForFailedInvoice(order: any, invoice: Stripe.Invoice) {
  const sourceCutoff = getFailedInvoiceSourceCutoff(invoice);
  if (!sourceCutoff) {
    return true;
  }

  return isCreatedNoLaterThan(
    order.created_at,
    sourceCutoff,
    STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS,
  );
}

function buildFailedInvoiceOrderMetadata(input: {
  existingMetadata?: unknown;
  invoice: Stripe.Invoice;
  invoiceId: string;
  subscriptionId: string | null;
  now: string;
}) {
  return {
    ...asRecord(input.existingMetadata),
    source: 'invoice.payment_failed',
    invoiceId: input.invoiceId,
    subscriptionId: input.subscriptionId,
    invoiceStatus: input.invoice.status ?? null,
    paymentIntentId: getInvoicePaymentIntentId(input.invoice),
    lastPaymentOrderStatus: 'failed',
    lastPaymentOrderStatusSource: 'invoice.payment_failed',
    lastPaymentOrderStatusAt: input.now,
  };
}

function buildFailedInvoiceOrderPayload(input: {
  sourceOrder: any;
  invoice: Stripe.Invoice;
  invoiceId: string;
  subscriptionId: string | null;
  now: string;
}) {
  return {
    user_id: input.sourceOrder.user_id,
    item_type: 'membership_plan',
    item_id: input.sourceOrder.item_id,
    billing_cycle: input.sourceOrder.billing_cycle ?? 'monthly',
    stripe_invoice_id: input.invoiceId,
    stripe_subscription_id: input.subscriptionId,
    stripe_customer_id: getInvoiceCustomerId(input.invoice) ?? input.sourceOrder.stripe_customer_id ?? null,
    stripe_price_id: input.sourceOrder.stripe_price_id ?? null,
    amount_total: getFailedInvoiceAmount(input.invoice),
    currency: input.invoice.currency ?? 'usd',
    mode: 'subscription',
    status: 'failed',
    payment_status: input.invoice.status ?? 'payment_failed',
    metadata: buildFailedInvoiceOrderMetadata({
      existingMetadata: input.sourceOrder.metadata,
      invoice: input.invoice,
      invoiceId: input.invoiceId,
      subscriptionId: input.subscriptionId,
      now: input.now,
    }),
    updated_at: input.now,
  };
}

function getMissingFailedInvoiceOrderFields(sourceOrder: any) {
  const missingFields: string[] = [];

  if (!sourceOrder?.user_id) {
    missingFields.push('user_id');
  }

  if (!sourceOrder?.item_id) {
    missingFields.push('item_id');
  }

  if (sourceOrder?.item_type && sourceOrder.item_type !== 'membership_plan') {
    missingFields.push('item_type');
  }

  return missingFields;
}

async function insertFailedInvoiceOrder(
  supabase: SupabaseLikeClient,
  invoice: Stripe.Invoice,
  subscriptionOrder: any,
  subscriptionId: string | null,
) {
  const invoiceId = invoice.id;
  const missingFields = getMissingFailedInvoiceOrderFields(subscriptionOrder);

  if (missingFields.length > 0) {
    logger.warn('billing', 'stripe_invoice_payment_failed_order_inference_incomplete', {
      invoiceId: maskIdentifier(invoiceId),
      subscriptionId: maskIdentifier(subscriptionId),
      sourceOrderId: maskIdentifier(subscriptionOrder?.id),
      sourceOrderStatus: subscriptionOrder?.status ?? null,
      missingFields,
    });
    return;
  }

  const now = new Date().toISOString();
  const payload = buildFailedInvoiceOrderPayload({
    sourceOrder: subscriptionOrder,
    invoice,
    invoiceId,
    subscriptionId,
    now,
  });

  const result = await supabase
    .from('payment_orders')
    .insert(payload);

  if (result.error) {
    throwFulfillmentError(
      'invoice_payment_failed_insert',
      STRIPE_FULFILLMENT_ERRORS.invoicePaymentFailedInsert,
      result.error,
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
        sourceOrderId: maskIdentifier(subscriptionOrder.id),
      },
    );
  }
}

export async function markMembershipInvoicePaymentFailed(
  supabase: SupabaseLikeClient,
  invoice: Stripe.Invoice,
) {
  const invoiceId = invoice.id;
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  const { invoiceOrder, subscriptionOrder } = await findInvoiceFailureOrders(
    supabase,
    invoice,
    subscriptionId,
  );
  const existingOrder = invoiceOrder ?? subscriptionOrder;

  if (!existingOrder?.id) {
    logger.warn('billing', 'stripe_invoice_payment_failed_order_missing', {
      invoiceId: maskIdentifier(invoiceId),
      subscriptionId: maskIdentifier(subscriptionId),
    });
    return;
  }

  if (!invoiceOrder && !isSourceOrderKnownForFailedInvoice(existingOrder, invoice)) {
    const isPlanChangeLock = isSubscriptionPlanChangeOrder(existingOrder);
    logger.info('billing', isPlanChangeLock
      ? 'stripe_invoice_payment_failed_plan_change_lock_preserved'
      : 'stripe_invoice_payment_failed_stale_source_preserved', {
      invoiceId: maskIdentifier(invoiceId),
      subscriptionId: maskIdentifier(subscriptionId),
      orderId: maskIdentifier(existingOrder.id),
      sourceOrderCreatedAt: existingOrder.created_at ?? null,
      invoiceCreatedAt: getFailedInvoiceSourceCutoff(invoice),
    });
    return;
  }

  if (!invoiceOrder && !isPendingCheckoutOrderForFirstInvoice(subscriptionOrder)) {
    await insertFailedInvoiceOrder(supabase, invoice, subscriptionOrder, subscriptionId);
    return;
  }

  const nextStatus = mergePaymentOrderStatus({
    existingStatus: existingOrder.status,
    fulfilledAt: existingOrder.fulfilled_at,
    nextStatus: 'failed',
  });

  if (nextStatus !== 'failed') {
    logger.info('billing', 'stripe_invoice_payment_failed_order_preserved', {
      invoiceId: maskIdentifier(invoiceId),
      subscriptionId: maskIdentifier(subscriptionId),
      orderId: maskIdentifier(existingOrder.id),
      existingStatus: normalizePaymentOrderStatus(existingOrder.status),
    });
    return;
  }

  const now = new Date().toISOString();
  const metadata = buildFailedInvoiceOrderMetadata({
    existingMetadata: existingOrder.metadata,
    invoice,
    invoiceId,
    subscriptionId,
    now,
  });
  const shouldReleasePlanChangeLock = isSubscriptionPlanChangeOrder(existingOrder);

  const result = await supabase
    .from('payment_orders')
    .update({
      stripe_invoice_id: invoiceId,
      ...(shouldReleasePlanChangeLock ? { stripe_checkout_session_id: null } : {}),
      stripe_subscription_id: subscriptionId,
      amount_total: getFailedInvoiceAmount(invoice),
      currency: invoice.currency ?? 'usd',
      status: 'failed',
      payment_status: invoice.status ?? 'payment_failed',
      metadata,
      updated_at: now,
    })
    .eq('id', existingOrder.id);

  if (result.error) {
    throwFulfillmentError(
      'invoice_payment_failed_update',
      STRIPE_FULFILLMENT_ERRORS.invoicePaymentFailedUpdate,
      result.error,
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
        orderId: maskIdentifier(existingOrder.id),
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

export async function reconcileSubscriptionRefundFromStripeWebhook(
  supabase: SupabaseLikeClient,
  event: StripeRefundWebhookEvent,
  options: {
    now?: string;
    retrieveCharge?: (chargeId: string) => Promise<Stripe.Charge>;
  } = {},
) {
  const retrieveCharge = options.retrieveCharge ?? retrieveStripeCharge;
  const now = options.now ?? new Date().toISOString();
  let charge: Stripe.Charge | null = null;
  let refundId: string | null = null;
  let refundStatus: string | null = null;
  let refundAmount = 0;
  let refundCurrency: string | null = null;
  let refundMetadata: Stripe.Metadata | null = null;

  if (event.type === 'charge.refunded') {
    charge = event.data.object;
    refundId = getChargeRefundId(charge) ?? charge.id;
    refundStatus = charge.status ?? null;
    refundAmount = toNonNegativeInteger(charge.amount_refunded);
    refundCurrency = charge.currency ?? null;
  } else {
    const refund = event.data.object;
    refundId = refund.id;
    refundStatus = refund.status ?? null;
    refundAmount = toNonNegativeInteger(refund.amount);
    refundCurrency = refund.currency ?? null;
    refundMetadata = refund.metadata ?? null;
    charge = await resolveRefundCharge(refund, retrieveCharge);
  }

  const invoiceId = getChargeInvoiceId(charge);
  const chargeId = charge?.id ?? null;
  const paymentIntentId = charge
    ? getChargePaymentIntentId(charge)
    : event.type === 'charge.refunded'
      ? null
      : getRefundPaymentIntentId(event.data.object);

  if (!invoiceId) {
    logger.warn('billing', 'stripe_refund_subscription_invoice_missing', {
      eventType: event.type,
      refundId: maskIdentifier(refundId),
      chargeId: maskIdentifier(chargeId),
      paymentIntentId: maskIdentifier(paymentIntentId),
    });
    return {
      reconciled: false,
      reason: 'invoice_missing',
      orderId: null,
      subscriptionId: null,
      refundId,
    };
  }

  const order = await getSubscriptionRefundOrderByInvoice(supabase, {
    invoiceId,
    eventType: event.type,
  });

  if (!isSubscriptionRefundOrder(order)) {
    logger.info('billing', 'stripe_refund_subscription_order_skipped', {
      eventType: event.type,
      refundId: maskIdentifier(refundId),
      invoiceId: maskIdentifier(invoiceId),
      orderId: maskIdentifier(order?.id),
      itemType: order?.item_type ?? null,
      hasSubscriptionId: Boolean(order?.stripe_subscription_id),
    });
    return {
      reconciled: false,
      reason: order?.id ? 'non_subscription_order' : 'order_missing',
      orderId: order?.id ?? null,
      subscriptionId: order?.stripe_subscription_id ?? null,
      refundId,
    };
  }

  try {
    const reconciliation = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: order.id as string,
      subscriptionId: order.stripe_subscription_id as string,
      refundId,
      refundEventType: event.type,
      refundStatus,
      refundAmount,
      refundCurrency,
      invoiceId,
      isFullRefund: isFullRefundForOrder({
        amountRefunded: refundAmount,
        charge,
        order,
        metadata: refundMetadata,
      }),
      now,
    });

    return {
      reconciled: true,
      reason: null,
      ...reconciliation,
    };
  } catch (error) {
    throwFulfillmentError(
      'refund_reconciliation',
      STRIPE_FULFILLMENT_ERRORS.refundReconciliation,
      error,
      {
        eventType: event.type,
        refundId: maskIdentifier(refundId),
        invoiceId: maskIdentifier(invoiceId),
        orderId: maskIdentifier(order.id),
        subscriptionId: maskIdentifier(order.stripe_subscription_id),
      },
    );
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

  const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
    amountTotal: invoice.amount_paid,
    currency: invoice.currency ?? 'usd',
    invoiceId,
    invoiceCreatedAt: asIsoTimestamp(invoice.created),
    paymentStatus: invoice.status ?? 'paid',
    periodEnd: asIsoTimestamp(invoice.period_end),
    periodStart: asIsoTimestamp(invoice.period_start),
    stripeCustomerId: typeof invoice.customer === 'string' ? invoice.customer : null,
    subscriptionId,
  });

  if (!result?.fulfilledAt) {
    throw new Error(STRIPE_FULFILLMENT_ERRORS.missingMembershipFulfilledAt);
  }

  await backfillCheckoutOrderFulfillment(supabase, subscriptionId, result.fulfilledAt);
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
