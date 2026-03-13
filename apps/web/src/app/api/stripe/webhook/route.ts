/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createServiceRoleSupabaseClient, getStripeClient, getStripeWebhookSecret } from '@repo/api/src/services/stripe';
import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '@repo/api/src/services/stripeFulfillment';
import type Stripe from 'stripe';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid webhook signature';
    return new Response(message, { status: 400 });
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
        await fulfillMembershipInvoice(supabase, event.data.object);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook handler failed';
    return new Response(message, { status: 500 });
  }

  return Response.json({ received: true });
}
