/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createServiceRoleSupabaseClient, getStripeClient, getStripeWebhookSecret } from '@repo/api/src/services/stripe';
import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  markMembershipInvoicePaymentFailed,
  reconcileSubscriptionRefundFromStripeWebhook,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '@repo/api/src/services/stripeFulfillment';
import { logServerError } from '@/lib/server-log';

export const runtime = 'nodejs';

type StripeWebhookEvent = ReturnType<
  ReturnType<typeof getStripeClient>['webhooks']['constructEvent']
>;

export async function handleStripeWebhookEvent(
  supabase: ReturnType<typeof createServiceRoleSupabaseClient>,
  event: StripeWebhookEvent,
) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      await upsertPaymentOrderBySession(supabase, session, {
        eventType: event.type,
      });
      if (session.mode === 'payment' && session.payment_status === 'paid') {
        await fulfillCreditPackageOrder(supabase, session);
      }
      break;
    }
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      await upsertPaymentOrderBySession(supabase, session, {
        eventType: event.type,
      });
      await fulfillCreditPackageOrder(supabase, session);
      break;
    }
    case 'checkout.session.async_payment_failed': {
      await upsertPaymentOrderBySession(supabase, event.data.object, {
        orderStatus: 'failed',
        eventType: event.type,
      });
      break;
    }
    case 'checkout.session.expired': {
      await upsertPaymentOrderBySession(supabase, event.data.object, {
        orderStatus: 'expired',
        eventType: event.type,
      });
      break;
    }
    case 'invoice.payment_succeeded': {
      await fulfillMembershipInvoice(supabase, event.data.object);
      break;
    }
    case 'invoice.payment_failed': {
      await markMembershipInvoicePaymentFailed(supabase, event.data.object);
      break;
    }
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated':
    case 'charge.refunded': {
      await reconcileSubscriptionRefundFromStripeWebhook(supabase, event);
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
    await handleStripeWebhookEvent(supabase, event);
  } catch {
    logServerError('billing', 'stripe_webhook_handler_failed', {
      eventType: event.type,
    });
    return new Response('Webhook handler failed', { status: 500 });
  }

  return Response.json({ received: true });
}
