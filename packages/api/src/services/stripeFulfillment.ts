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
  checkoutSubscriptionMissing: 'Stripe checkout session is missing subscription id',
  checkoutSubscriptionLookup: 'Failed to retrieve checkout subscription',
  checkoutInvoiceLookup: 'Failed to retrieve checkout subscription invoice',
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
  refundPaymentIntentLookup: 'Failed to retrieve Stripe refund payment intent',
  refundInvoiceLookup: 'Failed to resolve subscription refund invoice',
  refundOrderLookup: 'Failed to look up subscription refund order',
  refundOrderUpdate: 'Failed to update subscription refund order',
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
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[masked-email]',
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

function getCheckoutSessionInvoice(session: Stripe.Checkout.Session) {
  const sessionRecord = session as Stripe.Checkout.Session & {
    invoice?: string | Stripe.Invoice | null;
  };

  return sessionRecord.invoice ?? null;
}

function getCheckoutSessionInvoiceId(session: Stripe.Checkout.Session) {
  return getExpandableId(getCheckoutSessionInvoice(session));
}

function getSubscriptionLatestInvoice(subscription: Stripe.Subscription | null | undefined) {
  const subscriptionRecord = subscription as (Stripe.Subscription & {
    latest_invoice?: string | Stripe.Invoice | null;
  }) | null | undefined;

  return subscriptionRecord?.latest_invoice ?? null;
}

function getInvoiceStatus(invoice: Stripe.Invoice | null | undefined): string | null {
  if (!invoice) {
    return null;
  }

  const invoiceRecord = invoice as Stripe.Invoice & { paid?: boolean | null };
  if (invoice.status) {
    return invoice.status;
  }

  return invoiceRecord.paid === true ? 'paid' : null;
}

function isPaidInvoice(invoice: Stripe.Invoice | null | undefined): invoice is Stripe.Invoice {
  return Boolean(invoice?.id && getInvoiceStatus(invoice) === 'paid');
}

async function retrieveStripeInvoice(input: {
  stripe: ReturnType<typeof getStripeClient>;
  invoiceId: string;
  subscriptionId: string;
  source: string;
}) {
  try {
    return await input.stripe.invoices.retrieve(input.invoiceId);
  } catch (error) {
    throwFulfillmentError(
      'checkout_invoice_lookup',
      STRIPE_FULFILLMENT_ERRORS.checkoutInvoiceLookup,
      error,
      {
        invoiceId: maskIdentifier(input.invoiceId),
        subscriptionId: maskIdentifier(input.subscriptionId),
        source: input.source,
      },
    );
  }
}

type PaidCheckoutInvoiceResolution = {
  invoice: Stripe.Invoice | null;
  reason: 'paid_invoice_missing' | 'paid_invoice_unpaid' | null;
  sessionInvoiceId: string | null;
  sessionInvoiceStatus: string | null;
  latestInvoiceId: string | null;
  latestInvoiceStatus: string | null;
  invoiceListCount: number;
  invoiceListStatuses: string[];
};

type PaidMembershipCheckoutFulfillmentResult = {
  fulfilled: boolean;
  reason: 'not_paid_subscription_checkout' | 'paid_invoice_missing' | 'paid_invoice_unpaid' | null;
  invoiceId: string | null;
  subscriptionId: string | null;
};

function summarizeFulfillmentAuditError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      name: null,
      stage: null,
      code: null,
      message: typeof error === 'string' ? maskKnownIdentifiers(error.slice(0, 240)) : null,
    };
  }

  const errorRecord = error as {
    name?: unknown;
    stage?: unknown;
    code?: unknown;
    message?: unknown;
  };

  return {
    name: typeof errorRecord.name === 'string' ? errorRecord.name : null,
    stage: typeof errorRecord.stage === 'string' ? errorRecord.stage : null,
    code: typeof errorRecord.code === 'string' ? errorRecord.code : null,
    message: typeof errorRecord.message === 'string'
      ? maskKnownIdentifiers(errorRecord.message.slice(0, 240))
      : null,
  };
}

function buildInvoiceResolutionAudit(resolution: PaidCheckoutInvoiceResolution) {
  return {
    sessionInvoicePresent: Boolean(resolution.sessionInvoiceId || resolution.sessionInvoiceStatus),
    sessionInvoiceId: maskIdentifier(resolution.sessionInvoiceId),
    sessionInvoiceStatus: resolution.sessionInvoiceStatus,
    latestInvoicePresent: Boolean(resolution.latestInvoiceId || resolution.latestInvoiceStatus),
    latestInvoiceId: maskIdentifier(resolution.latestInvoiceId),
    latestInvoiceStatus: resolution.latestInvoiceStatus,
    invoiceListCount: resolution.invoiceListCount,
    invoiceListStatuses: resolution.invoiceListStatuses,
    paidInvoiceFound: Boolean(resolution.invoice?.id),
    reason: resolution.reason,
  };
}

async function resolvePaidCheckoutInvoice(input: {
  stripe: ReturnType<typeof getStripeClient>;
  session: Stripe.Checkout.Session;
  subscription: Stripe.Subscription;
  subscriptionId: string;
}): Promise<PaidCheckoutInvoiceResolution> {
  const resolution: PaidCheckoutInvoiceResolution = {
    invoice: null,
    reason: 'paid_invoice_missing',
    sessionInvoiceId: getCheckoutSessionInvoiceId(input.session),
    sessionInvoiceStatus: null,
    latestInvoiceId: getExpandableId(getSubscriptionLatestInvoice(input.subscription)),
    latestInvoiceStatus: null,
    invoiceListCount: 0,
    invoiceListStatuses: [],
  };

  const sessionInvoice = getCheckoutSessionInvoice(input.session);
  resolution.sessionInvoiceStatus = getInvoiceStatus(sessionInvoice as Stripe.Invoice | null);
  if (isPaidInvoice(sessionInvoice as Stripe.Invoice | null)) {
    return { ...resolution, invoice: sessionInvoice as Stripe.Invoice, reason: null };
  }

  if (resolution.sessionInvoiceId) {
    const invoice = await retrieveStripeInvoice({
      stripe: input.stripe,
      invoiceId: resolution.sessionInvoiceId,
      subscriptionId: input.subscriptionId,
      source: 'checkout_session_invoice',
    });
    resolution.sessionInvoiceStatus = getInvoiceStatus(invoice);
    if (isPaidInvoice(invoice)) {
      return { ...resolution, invoice, reason: null };
    }
  }

  const latestInvoice = getSubscriptionLatestInvoice(input.subscription);
  resolution.latestInvoiceId = getExpandableId(latestInvoice);
  resolution.latestInvoiceStatus = getInvoiceStatus(latestInvoice as Stripe.Invoice | null);
  if (isPaidInvoice(latestInvoice as Stripe.Invoice | null)) {
    return { ...resolution, invoice: latestInvoice as Stripe.Invoice, reason: null };
  }

  if (resolution.latestInvoiceId) {
    const invoice = await retrieveStripeInvoice({
      stripe: input.stripe,
      invoiceId: resolution.latestInvoiceId,
      subscriptionId: input.subscriptionId,
      source: 'subscription_latest_invoice',
    });
    resolution.latestInvoiceStatus = getInvoiceStatus(invoice);
    if (isPaidInvoice(invoice)) {
      return { ...resolution, invoice, reason: null };
    }
  }

  try {
    const invoices = (await input.stripe.invoices.list({
      subscription: input.subscriptionId,
      limit: 10,
    })).data;
    resolution.invoiceListCount = invoices.length;
    resolution.invoiceListStatuses = invoices
      .map((invoice) => getInvoiceStatus(invoice))
      .filter((status): status is string => Boolean(status));
    const paidInvoice = invoices.find((invoice) => isPaidInvoice(invoice)) ?? null;
    if (paidInvoice) {
      return { ...resolution, invoice: paidInvoice, reason: null };
    }

    const sawInvoice = Boolean(
      resolution.sessionInvoiceId
      || resolution.latestInvoiceId
      || resolution.sessionInvoiceStatus
      || resolution.latestInvoiceStatus
      || resolution.invoiceListCount > 0
    );

    return {
      ...resolution,
      reason: sawInvoice ? 'paid_invoice_unpaid' : 'paid_invoice_missing',
    };
  } catch (error) {
    throwFulfillmentError(
      'checkout_invoice_lookup',
      STRIPE_FULFILLMENT_ERRORS.checkoutInvoiceLookup,
      error,
      {
        checkoutSessionId: maskIdentifier(input.session.id),
        subscriptionId: maskIdentifier(input.subscriptionId),
        source: 'subscription_invoice_list',
      },
    );
  }
}

async function recordCheckoutFulfillmentAudit(input: {
  supabase: SupabaseLikeClient;
  session: Stripe.Checkout.Session;
  subscriptionId?: string | null;
  stage: string;
  reason: string | null;
  status?: 'blocked' | 'failed';
  resolution?: PaidCheckoutInvoiceResolution | null;
  error?: unknown;
  now?: string;
}) {
  try {
    const lookup = await input.supabase
      .from('payment_orders')
      .select('id, metadata')
      .eq('stripe_checkout_session_id', input.session.id)
      .maybeSingle();

    if (lookup.error) {
      logger.error('billing', 'checkout_fulfillment_audit_write_failed', {
        stage: input.stage,
        reason: input.reason,
        auditStage: 'lookup',
        checkoutSessionId: maskIdentifier(input.session.id),
        subscriptionId: maskIdentifier(input.subscriptionId),
        supabaseError: summarizeSupabaseError(lookup.error),
      });
      return;
    }

    if (!lookup.data?.id) {
      logger.warn('billing', 'checkout_fulfillment_audit_order_missing', {
        stage: input.stage,
        reason: input.reason,
        checkoutSessionId: maskIdentifier(input.session.id),
        subscriptionId: maskIdentifier(input.subscriptionId),
      });
      return;
    }

    const now = input.now ?? new Date().toISOString();
    const errorSummary = summarizeFulfillmentAuditError(input.error);
    const invoiceResolutionAudit = input.resolution
      ? buildInvoiceResolutionAudit(input.resolution)
      : undefined;
    const metadata = {
      ...asRecord(lookup.data.metadata),
      ...(invoiceResolutionAudit ? { invoiceResolutionAudit } : {}),
      syncCheckoutSessionFulfillment: {
        status: input.status ?? 'failed',
        stage: input.stage,
        reason: input.reason,
        checkoutStatus: input.session.status ?? null,
        paymentStatus: input.session.payment_status ?? null,
        subscriptionId: maskIdentifier(input.subscriptionId),
        ...(invoiceResolutionAudit ? { invoiceResolutionAudit } : {}),
        updatedAt: now,
      },
      lastFulfillmentError: {
        stage: input.stage,
        reason: input.reason,
        errorStage: errorSummary.stage,
        errorName: errorSummary.name,
        errorCode: errorSummary.code,
        message: errorSummary.message,
        updatedAt: now,
      },
    };

    const update = await input.supabase
      .from('payment_orders')
      .update({
        metadata,
        updated_at: now,
      })
      .eq('id', lookup.data.id);

    if (update.error) {
      logger.error('billing', 'checkout_fulfillment_audit_write_failed', {
        stage: input.stage,
        reason: input.reason,
        auditStage: 'update',
        checkoutSessionId: maskIdentifier(input.session.id),
        subscriptionId: maskIdentifier(input.subscriptionId),
        orderId: maskIdentifier(lookup.data.id),
        supabaseError: summarizeSupabaseError(update.error),
      });
    }
  } catch (auditError) {
    logger.error('billing', 'checkout_fulfillment_audit_write_failed', {
      stage: input.stage,
      reason: input.reason,
      auditStage: 'unexpected',
      checkoutSessionId: maskIdentifier(input.session.id),
      subscriptionId: maskIdentifier(input.subscriptionId),
      error: summarizeFulfillmentAuditError(auditError),
    });
  }
}

async function recordCheckoutFulfillmentFailure(input: {
  supabase: SupabaseLikeClient;
  session: Stripe.Checkout.Session;
  subscriptionId: string;
  resolution: PaidCheckoutInvoiceResolution;
  now?: string;
}) {
  await recordCheckoutFulfillmentAudit({
    supabase: input.supabase,
    session: input.session,
    subscriptionId: input.subscriptionId,
    stage: 'checkout_paid_invoice_resolution',
    reason: input.resolution.reason,
    status: 'blocked',
    resolution: input.resolution,
    now: input.now,
  });
}

async function recordCheckoutFulfillmentException(input: {
  supabase: SupabaseLikeClient;
  session: Stripe.Checkout.Session;
  subscriptionId?: string | null;
  stage: string;
  reason: string;
  error: unknown;
  resolution?: PaidCheckoutInvoiceResolution | null;
}) {
  await recordCheckoutFulfillmentAudit({
    supabase: input.supabase,
    session: input.session,
    subscriptionId: input.subscriptionId,
    stage: input.stage,
    reason: input.reason,
    status: 'failed',
    error: input.error,
    resolution: input.resolution,
  });
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

function getExpandedChargePaymentIntent(charge: Stripe.Charge | null | undefined) {
  return typeof charge?.payment_intent === 'object' && charge.payment_intent !== null
    ? charge.payment_intent as Stripe.PaymentIntent
    : null;
}

function getPaymentIntentInvoiceId(paymentIntent: Stripe.PaymentIntent | null | undefined) {
  const paymentIntentRecord = paymentIntent as (Stripe.PaymentIntent & {
    invoice?: string | Stripe.Invoice | null;
  }) | null | undefined;

  return getExpandableId(paymentIntentRecord?.invoice);
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
  const refund = getSuccessfulChargeRefund(charge) ?? charge.refunds?.data?.[0];
  return refund?.id ?? null;
}

function getChargeRefundStatus(charge: Stripe.Charge | null | undefined) {
  const refund = getSuccessfulChargeRefund(charge) ?? getChargeRefunds(charge)[0];
  return typeof refund?.status === 'string' ? refund.status : null;
}

function getChargeRefunds(charge: Stripe.Charge | null | undefined) {
  return (charge?.refunds?.data ?? []) as Array<Stripe.Refund & { status?: string | null }>;
}

function getSuccessfulChargeRefund(charge: Stripe.Charge | null | undefined) {
  return getChargeRefunds(charge).find((refund) =>
    isSuccessfulRefundStatus(refund.status),
  ) ?? null;
}

function getMetadataStringValue(metadata: unknown, keys: string[]) {
  const metadataRecord = asRecord(metadata);
  for (const key of keys) {
    const value = metadataRecord[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getMetadataInvoiceId(metadata: unknown) {
  return getMetadataStringValue(metadata, [
    'invoiceId',
    'stripeInvoiceId',
    'invoice_id',
    'stripe_invoice_id',
  ]);
}

function getMetadataPaymentIntentId(metadata: unknown) {
  return getMetadataStringValue(metadata, [
    'paymentIntentId',
    'stripePaymentIntentId',
    'payment_intent',
    'stripe_payment_intent_id',
  ]);
}

function getMetadataChargeId(metadata: unknown) {
  return getMetadataStringValue(metadata, [
    'chargeId',
    'stripeChargeId',
    'charge_id',
    'stripe_charge_id',
  ]);
}

function isSuccessfulRefundStatus(status: string | null | undefined) {
  const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return normalizedStatus === 'succeeded' || normalizedStatus === 'successful';
}

function isRefundReadyForCreditReconciliation(input: {
  eventType: StripeRefundWebhookEvent['type'];
  refundStatus: string | null;
  charge: Stripe.Charge | null;
}) {
  if (input.eventType === 'charge.refunded') {
    return Boolean(getSuccessfulChargeRefund(input.charge));
  }

  return isSuccessfulRefundStatus(input.refundStatus);
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
  const chargeAmountRefunded = toNonNegativeInteger(input.charge?.amount_refunded);
  if (orderAmount > 0) {
    return chargeAmountRefunded >= orderAmount || input.amountRefunded >= orderAmount;
  }

  const chargeAmount = toNonNegativeInteger(input.charge?.amount);
  if (chargeAmount > 0) {
    return chargeAmountRefunded >= chargeAmount || input.amountRefunded >= chargeAmount;
  }

  return input.charge?.refunded === true;
}

async function retrieveStripeCharge(chargeId: string) {
  try {
    return await getStripeClient().charges.retrieve(chargeId, {
      expand: ['invoice', 'payment_intent'],
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

async function retrieveStripePaymentIntent(paymentIntentId: string) {
  try {
    return await getStripeClient().paymentIntents.retrieve(paymentIntentId, {
      expand: ['invoice'],
    });
  } catch (error) {
    throwFulfillmentError(
      'refund_payment_intent_lookup',
      STRIPE_FULFILLMENT_ERRORS.refundPaymentIntentLookup,
      error,
      { paymentIntentId: maskIdentifier(paymentIntentId) },
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

const SUBSCRIPTION_REFUND_ORDER_SELECT = [
  'id',
  'user_id',
  'item_type',
  'billing_cycle',
  'status',
  'payment_status',
  'stripe_invoice_id',
  'stripe_subscription_id',
  'amount_total',
  'currency',
  'metadata',
].join(', ');

async function getSubscriptionRefundOrderByInvoice(
  supabase: SupabaseLikeClient,
  input: {
    invoiceId: string;
    eventType: string;
  },
): Promise<SubscriptionRefundOrderRow | null> {
  const result = await supabase
    .from('payment_orders')
    .select(SUBSCRIPTION_REFUND_ORDER_SELECT)
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

async function getSubscriptionRefundOrderByMetadataReference(
  supabase: SupabaseLikeClient,
  input: {
    eventType: string;
    refundId?: string | null;
    chargeId?: string | null;
    paymentIntentId?: string | null;
  },
): Promise<SubscriptionRefundOrderRow | null> {
  const referenceMarkers = [
    input.paymentIntentId
      ? [
        { paymentIntentId: input.paymentIntentId },
        { stripePaymentIntentId: input.paymentIntentId },
        { payment_intent: input.paymentIntentId },
        { stripe_payment_intent_id: input.paymentIntentId },
      ]
      : [],
    input.chargeId
      ? [
        { chargeId: input.chargeId },
        { stripeChargeId: input.chargeId },
        { charge_id: input.chargeId },
        { stripe_charge_id: input.chargeId },
      ]
      : [],
    input.refundId
      ? [
        { refundId: input.refundId },
        { stripeRefundId: input.refundId },
        { refund_id: input.refundId },
        { stripe_refund_id: input.refundId },
      ]
      : [],
  ].flat();

  for (const marker of referenceMarkers) {
    const result = await supabase
      .from('payment_orders')
      .select(SUBSCRIPTION_REFUND_ORDER_SELECT)
      .contains('metadata', marker)
      .limit(1);

    if (result.error) {
      throwFulfillmentError(
        'refund_order_lookup',
        STRIPE_FULFILLMENT_ERRORS.refundOrderLookup,
        result.error,
        {
          eventType: input.eventType,
          refundId: maskIdentifier(input.refundId),
          chargeId: maskIdentifier(input.chargeId),
          paymentIntentId: maskIdentifier(input.paymentIntentId),
        },
      );
    }

    if ((result.data ?? []).length > 0) {
      return result.data[0] ?? null;
    }
  }

  return null;
}

async function resolveSubscriptionRefundInvoice(input: {
  supabase: SupabaseLikeClient;
  eventType: string;
  refundId: string | null;
  refundMetadata: Stripe.Metadata | null;
  charge: Stripe.Charge | null;
  chargeId: string | null;
  paymentIntentId: string | null;
  retrievePaymentIntent: (paymentIntentId: string) => Promise<Stripe.PaymentIntent>;
}): Promise<{ invoiceId: string | null; order: SubscriptionRefundOrderRow | null }> {
  const invoiceIdFromMetadata = getMetadataInvoiceId(input.refundMetadata)
    ?? getMetadataInvoiceId(input.charge?.metadata);
  const invoiceIdFromCharge = getChargeInvoiceId(input.charge);
  const invoiceIdFromExpandedPaymentIntent = getPaymentIntentInvoiceId(
    getExpandedChargePaymentIntent(input.charge),
  );
  let invoiceIdFromRetrievedPaymentIntent: string | null = null;

  if (
    !invoiceIdFromMetadata
    && !invoiceIdFromCharge
    && !invoiceIdFromExpandedPaymentIntent
    && input.paymentIntentId
  ) {
    const paymentIntent = await input.retrievePaymentIntent(input.paymentIntentId);
    invoiceIdFromRetrievedPaymentIntent = getPaymentIntentInvoiceId(paymentIntent);
  }

  const invoiceId = invoiceIdFromMetadata
    ?? invoiceIdFromCharge
    ?? invoiceIdFromExpandedPaymentIntent
    ?? invoiceIdFromRetrievedPaymentIntent;

  if (invoiceId) {
    return {
      invoiceId,
      order: null,
    };
  }

  const order = await getSubscriptionRefundOrderByMetadataReference(input.supabase, {
    eventType: input.eventType,
    refundId: input.refundId,
    chargeId: input.chargeId,
    paymentIntentId: input.paymentIntentId,
  });

  return {
    invoiceId: order?.stripe_invoice_id?.trim() || null,
    order,
  };
}

async function recordSubscriptionRefundWebhookAudit(input: {
  supabase: SupabaseLikeClient;
  order: SubscriptionRefundOrderRow & { id: string; stripe_subscription_id: string };
  eventType: StripeRefundWebhookEvent['type'];
  refundId: string | null;
  refundStatus: string | null;
  refundAmount: number;
  refundCurrency: string | null;
  invoiceId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  now: string;
}) {
  const status = typeof input.refundStatus === 'string'
    ? input.refundStatus.trim().toLowerCase()
    : null;
  const reconciliationStatus = status
    ? status === 'pending' || status === 'requires_action'
      ? 'waiting_for_successful_refund'
      : 'ignored_non_successful_refund'
    : 'waiting_for_successful_refund_status';
  const metadata = {
    ...asRecord(input.order.metadata),
    stripeRefundWebhookAudit: {
      ...asRecord(asRecord(input.order.metadata).stripeRefundWebhookAudit),
      refundId: input.refundId,
      eventType: input.eventType,
      refundStatus: input.refundStatus,
      refundAmount: input.refundAmount,
      currency: input.refundCurrency,
      invoiceId: input.invoiceId,
      chargeId: input.chargeId,
      paymentIntentId: input.paymentIntentId,
      reconciliationStatus,
      creditClawbackApplied: false,
      grantReversalApplied: false,
      auditedAt: input.now,
      source: 'stripe_refund_webhook',
    },
  };

  const result = await input.supabase
    .from('payment_orders')
    .update({
      metadata,
      updated_at: input.now,
    })
    .eq('id', input.order.id);

  if (result.error) {
    throwFulfillmentError(
      'refund_order_update',
      STRIPE_FULFILLMENT_ERRORS.refundOrderUpdate,
      result.error,
      {
        eventType: input.eventType,
        refundId: maskIdentifier(input.refundId),
        invoiceId: maskIdentifier(input.invoiceId),
        orderId: maskIdentifier(input.order.id),
        subscriptionId: maskIdentifier(input.order.stripe_subscription_id),
      },
    );
  }
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
    retrievePaymentIntent?: (paymentIntentId: string) => Promise<Stripe.PaymentIntent>;
  } = {},
) {
  const retrieveCharge = options.retrieveCharge ?? retrieveStripeCharge;
  const retrievePaymentIntent = options.retrievePaymentIntent ?? retrieveStripePaymentIntent;
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
    refundStatus = getChargeRefundStatus(charge) ?? null;
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

  const chargeId = charge?.id ?? null;
  const paymentIntentId = getMetadataPaymentIntentId(refundMetadata)
    ?? getMetadataPaymentIntentId(charge?.metadata)
    ?? (
      charge
        ? getChargePaymentIntentId(charge)
        : event.type === 'charge.refunded'
          ? null
          : getRefundPaymentIntentId(event.data.object)
    );
  const resolvedChargeId = getMetadataChargeId(refundMetadata)
    ?? getMetadataChargeId(charge?.metadata)
    ?? chargeId;
  const resolvedInvoice = await resolveSubscriptionRefundInvoice({
    supabase,
    eventType: event.type,
    refundId,
    refundMetadata,
    charge,
    chargeId: resolvedChargeId,
    paymentIntentId,
    retrievePaymentIntent,
  });
  const invoiceId = resolvedInvoice.invoiceId;

  if (!invoiceId) {
    throwFulfillmentError(
      'refund_subscription_invoice_missing',
      STRIPE_FULFILLMENT_ERRORS.refundInvoiceLookup,
      new Error('subscription refund invoice missing; retry webhook'),
      {
        eventType: event.type,
        refundId: maskIdentifier(refundId),
        chargeId: maskIdentifier(resolvedChargeId),
        paymentIntentId: maskIdentifier(paymentIntentId),
        metadataOrderId: maskIdentifier(resolvedInvoice.order?.id),
      },
    );
  }

  const order = resolvedInvoice.order?.stripe_invoice_id === invoiceId
    ? resolvedInvoice.order
    : await getSubscriptionRefundOrderByInvoice(supabase, {
      invoiceId,
      eventType: event.type,
    });

  if (!order?.id) {
    throwFulfillmentError(
      'refund_subscription_order_missing',
      STRIPE_FULFILLMENT_ERRORS.refundOrderLookup,
      new Error('subscription refund invoice payment order missing; retry webhook'),
      {
        eventType: event.type,
        refundId: maskIdentifier(refundId),
        invoiceId: maskIdentifier(invoiceId),
        chargeId: maskIdentifier(resolvedChargeId),
        paymentIntentId: maskIdentifier(paymentIntentId),
      },
    );
  }

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

  if (!isRefundReadyForCreditReconciliation({
    eventType: event.type,
    refundStatus,
    charge,
  })) {
    await recordSubscriptionRefundWebhookAudit({
      supabase,
      order,
      eventType: event.type,
      refundId,
      refundStatus,
      refundAmount,
      refundCurrency,
      invoiceId,
      chargeId: resolvedChargeId,
      paymentIntentId,
      now,
    });

    logger.info('billing', 'stripe_refund_subscription_waiting_for_successful_refund', {
      eventType: event.type,
      refundId: maskIdentifier(refundId),
      refundStatus,
      invoiceId: maskIdentifier(invoiceId),
      orderId: maskIdentifier(order.id),
      subscriptionId: maskIdentifier(order.stripe_subscription_id),
    });

    return {
      reconciled: false,
      reason: 'refund_not_successful',
      orderId: order.id,
      subscriptionId: order.stripe_subscription_id,
      refundId,
      refundStatus,
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

    const logContext = {
      eventType: event.type,
      refundId: maskIdentifier(refundId),
      refundStatus,
      invoiceId: maskIdentifier(invoiceId),
      orderId: maskIdentifier(order.id),
      subscriptionId: maskIdentifier(order.stripe_subscription_id),
      fullRefund: reconciliation.fullRefund,
      reviewRequired: reconciliation.reviewRequired,
      clawbackAmount: reconciliation.clawbackAmount,
      appliedClawbackAmount: reconciliation.appliedClawbackAmount,
      shortfallAmount: reconciliation.shortfallAmount,
      reversedGrantCount: reconciliation.reversedGrantCount,
      alreadyReconciled: reconciliation.alreadyReconciled,
    };

    if (reconciliation.reviewRequired) {
      logger.warn('billing', 'stripe_refund_subscription_reconciliation_review_required', logContext);
    } else {
      logger.info('billing', 'stripe_refund_subscription_reconciled', logContext);
    }

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

  if (result?.skippedReason === 'blocked_by_refund_marker') {
    return;
  }

  if (!result?.fulfilledAt) {
    throwFulfillmentError(
      'fulfill_membership_invoice_missing_fulfilled_at',
      STRIPE_FULFILLMENT_ERRORS.missingMembershipFulfilledAt,
      new Error('membership invoice fulfillment returned no fulfilled_at'),
      {
        invoiceId: maskIdentifier(invoiceId),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
  }

  await backfillCheckoutOrderFulfillment(supabase, subscriptionId, result.fulfilledAt);
}

export async function fulfillPaidMembershipCheckoutSession(
  supabase: SupabaseLikeClient,
  stripe: ReturnType<typeof getStripeClient>,
  session: Stripe.Checkout.Session,
): Promise<PaidMembershipCheckoutFulfillmentResult> {
  if (session.mode !== 'subscription' || session.payment_status !== 'paid') {
    return {
      fulfilled: false,
      reason: 'not_paid_subscription_checkout',
      invoiceId: null,
      subscriptionId: getCheckoutSessionSubscriptionId(session),
    };
  }

  const subscriptionId = getCheckoutSessionSubscriptionId(session);
  if (!subscriptionId) {
    await recordCheckoutFulfillmentException({
      supabase,
      session,
      subscriptionId: null,
      stage: 'checkout_subscription_parse',
      reason: 'checkout_subscription_missing',
      error: new Error('checkout session subscription id missing'),
    });
    throwFulfillmentError(
      'checkout_subscription_parse',
      STRIPE_FULFILLMENT_ERRORS.checkoutSubscriptionMissing,
      new Error('checkout session subscription id missing'),
      { checkoutSessionId: maskIdentifier(session.id) },
    );
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = typeof session.subscription === 'string'
      ? await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['latest_invoice'],
        })
      : session.subscription as Stripe.Subscription;

    if (!getSubscriptionLatestInvoice(subscription)) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice'],
      });
    }
  } catch (error) {
    await recordCheckoutFulfillmentException({
      supabase,
      session,
      subscriptionId,
      stage: 'checkout_subscription_lookup',
      reason: 'subscription_retrieve_failed',
      error,
    });
    throwFulfillmentError(
      'checkout_subscription_lookup',
      STRIPE_FULFILLMENT_ERRORS.checkoutSubscriptionLookup,
      error,
      {
        checkoutSessionId: maskIdentifier(session.id),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
  }

  if (!subscription) {
    await recordCheckoutFulfillmentException({
      supabase,
      session,
      subscriptionId,
      stage: 'checkout_subscription_lookup',
      reason: 'subscription_unavailable',
      error: new Error('Stripe subscription unavailable'),
    });
    throwFulfillmentError(
      'checkout_subscription_lookup',
      STRIPE_FULFILLMENT_ERRORS.checkoutSubscriptionLookup,
      new Error('Stripe subscription unavailable'),
      {
        checkoutSessionId: maskIdentifier(session.id),
        subscriptionId: maskIdentifier(subscriptionId),
      },
    );
  }

  try {
    await syncSubscriptionState(supabase, subscription);
  } catch (error) {
    await recordCheckoutFulfillmentException({
      supabase,
      session,
      subscriptionId,
      stage: 'sync_subscription_state',
      reason: 'subscription_state_sync_failed',
      error,
    });
    throw error;
  }

  let invoiceResolution: PaidCheckoutInvoiceResolution;
  try {
    invoiceResolution = await resolvePaidCheckoutInvoice({
      stripe,
      session,
      subscription,
      subscriptionId,
    });
  } catch (error) {
    await recordCheckoutFulfillmentException({
      supabase,
      session,
      subscriptionId,
      stage: 'invoice_resolution_fallback',
      reason: 'invoice_resolution_failed',
      error,
    });
    throw error;
  }
  const paidInvoice = invoiceResolution.invoice;

  if (!paidInvoice) {
    await recordCheckoutFulfillmentFailure({
      supabase,
      session,
      subscriptionId,
      resolution: invoiceResolution,
    });

    logger.warn('billing', 'paid_membership_checkout_invoice_missing', {
      checkoutSessionId: maskIdentifier(session.id),
      subscriptionId: maskIdentifier(subscriptionId),
      reason: invoiceResolution.reason,
      sessionInvoiceId: maskIdentifier(invoiceResolution.sessionInvoiceId),
      sessionInvoiceStatus: invoiceResolution.sessionInvoiceStatus,
      latestInvoiceId: maskIdentifier(invoiceResolution.latestInvoiceId),
      latestInvoiceStatus: invoiceResolution.latestInvoiceStatus,
      invoiceListCount: invoiceResolution.invoiceListCount,
      invoiceListStatuses: invoiceResolution.invoiceListStatuses,
    });

    throwFulfillmentError(
      'checkout_paid_invoice_resolution',
      STRIPE_FULFILLMENT_ERRORS.checkoutInvoiceLookup,
      new Error('paid checkout session has no paid invoice available for fulfillment'),
      {
        checkoutSessionId: maskIdentifier(session.id),
        subscriptionId: maskIdentifier(subscriptionId),
        reason: invoiceResolution.reason,
        sessionInvoiceId: maskIdentifier(invoiceResolution.sessionInvoiceId),
        sessionInvoiceStatus: invoiceResolution.sessionInvoiceStatus,
        latestInvoiceId: maskIdentifier(invoiceResolution.latestInvoiceId),
        latestInvoiceStatus: invoiceResolution.latestInvoiceStatus,
        invoiceListCount: invoiceResolution.invoiceListCount,
        invoiceListStatuses: invoiceResolution.invoiceListStatuses,
      },
    );
  }

  try {
    await fulfillMembershipInvoice(supabase, paidInvoice);
  } catch (error) {
    await recordCheckoutFulfillmentException({
      supabase,
      session,
      subscriptionId,
      stage: 'fulfill_membership_invoice',
      reason: 'membership_invoice_fulfillment_failed',
      error,
      resolution: invoiceResolution,
    });
    throw error;
  }

  return {
    fulfilled: true,
    reason: null,
    invoiceId: paidInvoice.id,
    subscriptionId,
  };
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

  const existingSubscriptionQuery = supabase
    .from('user_subscriptions')
    .select('id, user_id, membership_plan_id, status, created_at')
    .eq('stripe_subscription_id', subscriptionId);
  const orderedExistingSubscriptionQuery = typeof existingSubscriptionQuery.order === 'function'
    ? existingSubscriptionQuery.order('created_at', { ascending: true })
    : existingSubscriptionQuery;
  const limitedExistingSubscriptionQuery = typeof orderedExistingSubscriptionQuery.limit === 'function'
    ? orderedExistingSubscriptionQuery.limit(10)
    : orderedExistingSubscriptionQuery;
  const { data: existingSubscriptionData, error: existingSubscriptionError } =
    typeof limitedExistingSubscriptionQuery.then === 'function'
      ? await limitedExistingSubscriptionQuery
      : await limitedExistingSubscriptionQuery.maybeSingle();

  if (existingSubscriptionError) {
    throwFulfillmentError(
      'subscription_state_lookup',
      STRIPE_FULFILLMENT_ERRORS.subscriptionLookup,
      existingSubscriptionError,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  const existingSubscriptions = Array.isArray(existingSubscriptionData)
    ? existingSubscriptionData
    : existingSubscriptionData
      ? [existingSubscriptionData]
      : [];
  const existingSubscription = existingSubscriptions[0] ?? null;
  if (existingSubscriptions.length > 1) {
    logger.warn('billing', 'subscription_state_duplicate_mirror_detected', {
      subscriptionId: maskIdentifier(subscriptionId),
      subscriptionCount: existingSubscriptions.length,
      canonicalSubscriptionId: maskIdentifier(existingSubscription?.id),
    });
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
