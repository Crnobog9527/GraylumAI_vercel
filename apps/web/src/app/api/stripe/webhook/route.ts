/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createServiceRoleSupabaseClient, getStripeClient, getStripeWebhookSecret } from '@repo/api/src/services/stripe';
import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  fulfillPaidMembershipCheckoutSession,
  markMembershipInvoicePaymentFailed,
  reconcileSubscriptionRefundFromStripeWebhook,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '@repo/api/src/services/stripeFulfillment';
import { reportPaymentEvidenceConflict } from '@/lib/payment-alert.mjs';
import { PAYMENT_EVIDENCE_CONFLICT, stripeWebhookErrorCode } from '@repo/api/src/services/payments/stripeWebhookError';
import { recoverMethodCheckout } from '@repo/api/src/services/payments/walletWebhook';
import { handleCardSubscriptionInvoice, handleCardSubscriptionState } from '@repo/api/src/services/payments/cardSubscriptionWebhook';
import { handleCardRefund, handlePaymentDispute } from '@repo/api/src/services/payments/cardRefundWebhook';
import { reportPaymentDispute } from '@/lib/payment-dispute-alert.mjs';
import { logServerError } from '@/lib/server-log';

export const runtime = 'nodejs';

type StripeWebhookEvent = ReturnType<
  ReturnType<typeof getStripeClient>['webhooks']['constructEvent']
>;

export async function handleStripeWebhookEvent(
  supabase: ReturnType<typeof createServiceRoleSupabaseClient>,
  event: StripeWebhookEvent,
) {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded'
    || event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    // Wallet and PAY-STRIPE-MP card orders never take the legacy recording path below.
    if (await recoverMethodCheckout(supabase, getStripeClient(), event.data.object.id, event.type, reportPaymentDispute)) return;
  }
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
    // Money kept for review on a card subscription (renewal stopped at Stripe) raises the payment-evidence alert.
    if (await handleCardSubscriptionInvoice(supabase, getStripeClient(), event.data.object.id, event.type, event.created,
      () => reportPaymentEvidenceConflict(event.type))) return;
  }
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated'
    || event.type === 'customer.subscription.deleted') {
    if (await handleCardSubscriptionState(supabase, getStripeClient(), event.data.object.id)) return;
  }
  if (event.type === 'charge.refunded' || event.type === 'refund.created' || event.type === 'refund.updated'
    || event.type === 'refund.failed' || event.type === 'charge.refund.updated') {
    // PAY-STRIPE-MP card orders: external refunds are recorded on the card order; others keep the legacy path.
    const input = event.type === 'charge.refunded' ? { chargeId: event.data.object.id } : { refundId: event.data.object.id };
    if (await handleCardRefund(supabase, getStripeClient(), input, () => reportPaymentEvidenceConflict(event.type))) return;
  }
  if (event.type.startsWith('charge.dispute.')) {
    await handlePaymentDispute(supabase, getStripeClient(), event, reportPaymentDispute);
    return;
  }
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = await upsertPaymentOrderBySession(supabase, event.data.object, {
        eventType: event.type,
      });
      if (session.mode === 'payment' && session.payment_status === 'paid') {
        await fulfillCreditPackageOrder(supabase, session);
      }
      if (session.mode === 'subscription' && session.payment_status === 'paid') {
        await fulfillPaidMembershipCheckoutSession(supabase, getStripeClient(), session);
      }
      break;
    }
    case 'checkout.session.async_payment_succeeded': {
      const session = await upsertPaymentOrderBySession(supabase, event.data.object, {
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
    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
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
    case 'customer.subscription.created':
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
  } catch (error) {
    const code = stripeWebhookErrorCode(error);
    logServerError('billing', 'stripe_webhook_handler_failed', { eventType: event.type, code });
    if (code === PAYMENT_EVIDENCE_CONFLICT) {
      // This error is caught here, so Next's uncaught request-error hook does not report it.
      // Emit only a fixed message and structural tags; never send the payment payload.
      reportPaymentEvidenceConflict(event.type);
    }
    return new Response('Webhook handler failed', { status: 500 });
  }

  return Response.json({ received: true });
}
