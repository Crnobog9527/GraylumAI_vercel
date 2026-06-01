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

const INVOICE_REFUND_LOOKUP_EXPANSIONS = [
  'payments',
  'payments.data.payment.charge',
  'payments.data.payment.payment_intent',
  'payments.data.payment.payment_intent.latest_charge',
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
        await reconcileStripeRefund(supabase, {
          eventId: event.id,
          eventType: event.type,
          charge: event.data.object,
        });
        break;
      }
      case 'charge.refund.updated':
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        await reconcileStripeRefund(supabase, {
          eventId: event.id,
          eventType: event.type,
          refund: event.data.object,
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
