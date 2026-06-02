/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createServiceRoleSupabaseClient, getStripeClient, getStripeWebhookSecret } from '@repo/api/src/services/stripe';
import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  reconcileStripeRefund,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '@repo/api/src/services/stripeFulfillment';
import { logServerError } from '@/lib/server-log';

export const runtime = 'nodejs';

type StripeWebhookEvent = ReturnType<
  ReturnType<typeof getStripeClient>['webhooks']['constructEvent']
>;
type StripeInvoice = Parameters<typeof fulfillMembershipInvoice>[1];
type RefundReconciliationInput = Parameters<typeof reconcileStripeRefund>[1];
type StripeCharge = Extract<RefundReconciliationInput, { charge: unknown }>['charge'];
type StripeRefund = Extract<RefundReconciliationInput, { refund: unknown }>['refund'];

const INVOICE_REFUND_LOOKUP_EXPANSIONS = [
  'payments',
  'payments.data.payment.charge',
  'payments.data.payment.payment_intent',
  'payments.data.payment.payment_intent.latest_charge',
] as const;
const CHARGE_REFUND_LOOKUP_EXPANSIONS = [
  'payment_intent',
] as const;
const REFUND_REFUND_LOOKUP_EXPANSIONS = [
  'charge',
  'charge.payment_intent',
  'payment_intent',
] as const;
const INVOICE_PAYMENT_REFUND_LOOKUP_EXPANSIONS = [
  'data.invoice',
] as const;

function maskStripeIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function getStripeObjectId(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function getPaymentIntentValue(object: unknown) {
  if (!object || typeof object !== 'object') {
    return null;
  }

  return (object as { payment_intent?: unknown }).payment_intent ?? null;
}

function getPaymentIntentId(object: unknown) {
  return getStripeObjectId(getPaymentIntentValue(object));
}

function getPaymentIntentInvoiceId(object: unknown) {
  const paymentIntent = getPaymentIntentValue(object);

  if (!paymentIntent || typeof paymentIntent !== 'object') {
    return null;
  }

  return getStripeObjectId((paymentIntent as { invoice?: unknown }).invoice);
}

function attachInvoiceToPaymentIntent<T extends object>(
  object: T,
  paymentIntentId: string,
  invoice: unknown,
) {
  const record = object as Record<string, unknown>;
  const currentPaymentIntent = record.payment_intent;
  const paymentIntent = currentPaymentIntent && typeof currentPaymentIntent === 'object'
    ? {
        ...(currentPaymentIntent as Record<string, unknown>),
        invoice,
      }
    : {
        id: paymentIntentId,
        invoice,
      };

  return {
    ...record,
    payment_intent: paymentIntent,
  } as T;
}

async function retrieveInvoiceWithRefundLookupDetails(invoice: StripeInvoice) {
  if (!invoice.id) {
    return invoice;
  }

  try {
    return await getStripeClient().invoices.retrieve(invoice.id, {
      expand: [...INVOICE_REFUND_LOOKUP_EXPANSIONS],
    });
  } catch {
    logServerError('billing', 'stripe_invoice_refund_lookup_retrieve_failed', {
      invoiceId: maskStripeIdentifier(invoice.id),
    });
    return invoice;
  }
}

async function retrieveInvoiceForPaymentIntent(paymentIntentId: string) {
  try {
    const invoicePayments = await getStripeClient().invoicePayments.list({
      limit: 1,
      payment: {
        type: 'payment_intent',
        payment_intent: paymentIntentId,
      },
      expand: [...INVOICE_PAYMENT_REFUND_LOOKUP_EXPANSIONS],
    });

    return invoicePayments.data?.[0]?.invoice ?? null;
  } catch {
    logServerError('billing', 'stripe_invoice_payment_refund_lookup_retrieve_failed', {
      paymentIntentId: maskStripeIdentifier(paymentIntentId),
    });
    return null;
  }
}

async function attachInvoicePaymentLookupToCharge(charge: StripeCharge) {
  const paymentIntentId = getPaymentIntentId(charge);

  if (!paymentIntentId || getPaymentIntentInvoiceId(charge)) {
    return charge;
  }

  const invoice = await retrieveInvoiceForPaymentIntent(paymentIntentId);

  if (!invoice) {
    return charge;
  }

  return attachInvoiceToPaymentIntent(charge, paymentIntentId, invoice);
}

async function retrieveChargeWithRefundLookupDetails(charge: StripeCharge) {
  if (!charge.id) {
    return attachInvoicePaymentLookupToCharge(charge);
  }

  try {
    const retrieved = await getStripeClient().charges.retrieve(charge.id, {
      expand: [...CHARGE_REFUND_LOOKUP_EXPANSIONS],
    });

    return attachInvoicePaymentLookupToCharge(retrieved ?? charge);
  } catch {
    logServerError('billing', 'stripe_charge_refund_lookup_retrieve_failed', {
      chargeId: maskStripeIdentifier(charge.id),
    });
    return attachInvoicePaymentLookupToCharge(charge);
  }
}

async function attachInvoicePaymentLookupToRefund(refund: StripeRefund) {
  const paymentIntentId = getPaymentIntentId(refund);

  if (!paymentIntentId || getPaymentIntentInvoiceId(refund)) {
    return refund;
  }

  const invoice = await retrieveInvoiceForPaymentIntent(paymentIntentId);

  if (!invoice) {
    return refund;
  }

  return attachInvoiceToPaymentIntent(refund, paymentIntentId, invoice);
}

async function retrieveRefundWithRefundLookupDetails(refund: StripeRefund) {
  if (!refund.id) {
    return attachInvoicePaymentLookupToRefund(refund);
  }

  try {
    const retrieved = await getStripeClient().refunds.retrieve(refund.id, {
      expand: [...REFUND_REFUND_LOOKUP_EXPANSIONS],
    });

    const enrichedRefund = await attachInvoicePaymentLookupToRefund(retrieved ?? refund);
    const chargeId = getStripeObjectId(enrichedRefund.charge);

    if (enrichedRefund.charge && typeof enrichedRefund.charge === 'object') {
      return {
        ...enrichedRefund,
        charge: await attachInvoicePaymentLookupToCharge(enrichedRefund.charge),
      };
    }

    if (chargeId && typeof enrichedRefund.charge !== 'object') {
      const expandedCharge = await retrieveChargeWithRefundLookupDetails({
        id: chargeId,
      } as StripeCharge);

      return {
        ...enrichedRefund,
        charge: expandedCharge,
      };
    }

    return enrichedRefund;
  } catch {
    logServerError('billing', 'stripe_refund_lookup_retrieve_failed', {
      refundId: maskStripeIdentifier(refund.id),
      chargeId: maskStripeIdentifier(getStripeObjectId(refund.charge)),
    });
    return attachInvoicePaymentLookupToRefund(refund);
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const rawBody = await request.text();

  let event: StripeWebhookEvent;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  } catch {
    logServerError('billing', 'stripe_webhook_invalid_signature');
    return new Response('Invalid webhook signature', { status: 400 });
  }

  const supabase = createServiceRoleSupabaseClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await upsertPaymentOrderBySession(supabase, session);
        if (session.mode === 'payment' && session.payment_status === 'paid') {
          await fulfillCreditPackageOrder(supabase, session);
        }
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        await upsertPaymentOrderBySession(supabase, session);
        await fulfillCreditPackageOrder(supabase, session);
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = await retrieveInvoiceWithRefundLookupDetails(event.data.object);
        await fulfillMembershipInvoice(supabase, invoice);
        break;
      }
      case 'charge.refunded': {
        const charge = await retrieveChargeWithRefundLookupDetails(event.data.object);
        await reconcileStripeRefund(supabase, {
          eventId: event.id,
          eventType: event.type,
          charge,
        });
        break;
      }
      case 'charge.refund.updated':
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        const refund = await retrieveRefundWithRefundLookupDetails(event.data.object);
        await reconcileStripeRefund(supabase, {
          eventId: event.id,
          eventType: event.type,
          refund,
        });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscriptionState(supabase, event.data.object);
        break;
      }
      default:
        break;
    }
  } catch {
    logServerError('billing', 'stripe_webhook_handler_failed', {
      eventType: event.type,
    });
    return new Response('Webhook handler failed', { status: 500 });
  }

  return Response.json({ received: true });
}
