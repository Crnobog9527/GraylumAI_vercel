/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createServiceRoleSupabaseClient, getStripeClient, getStripeWebhookSecret } from '@repo/api/src/services/stripe';
import { reconcileSubscriptionRefundFromStripeWebhook } from '@repo/api/src/services/stripeFulfillment';
import { reportPaymentEvidenceConflict } from '@/lib/payment-alert.mjs';
import { PAYMENT_EVIDENCE_CONFLICT, stripeWebhookErrorCode } from '@repo/api/src/services/payments/stripeWebhookError';
import { recoverMethodCheckout } from '@repo/api/src/services/payments/walletWebhook';
import { recoverWalletPaymentFailure } from '@repo/api/src/services/payments/walletPaymentFailure';
import { handleCardSubscriptionInvoice, handleCardSubscriptionState } from '@repo/api/src/services/payments/cardSubscriptionWebhook';
import { handleCardRefund, handlePaymentDispute } from '@repo/api/src/services/payments/cardRefundWebhook';
import { reportPaymentDispute } from '@/lib/payment-dispute-alert.mjs';
import { logServerError, logServerWarn } from '@/lib/server-log';

export const runtime = 'nodejs';

type StripeWebhookEvent = ReturnType<
  ReturnType<typeof getStripeClient>['webhooks']['constructEvent']
>;

export async function handleStripeWebhookEvent(
  supabase: ReturnType<typeof createServiceRoleSupabaseClient>,
  event: StripeWebhookEvent,
) {
  if (event.type === 'payment_intent.payment_failed') {
    await recoverWalletPaymentFailure(supabase, getStripeClient(), event.data.object.id, reportPaymentDispute);
    return;
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded'
    || event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    // Wallet and PAY-STRIPE-MP card orders.
    if (await recoverMethodCheckout(supabase, getStripeClient(), event.data.object.id, event.type, reportPaymentDispute)) return;
  }
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
    // Money kept for review on a card subscription (renewal stopped at Stripe) raises the payment-evidence alert.
    if (await handleCardSubscriptionInvoice(supabase, getStripeClient(), event.data.object.id, event.type, event.created,
      () => reportPaymentEvidenceConflict(event.type), reportPaymentDispute)) return;
  }
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated'
    || event.type === 'customer.subscription.deleted') {
    if (await handleCardSubscriptionState(supabase, getStripeClient(), event.data.object.id)) return;
  }
  if (event.type === 'charge.refunded' || event.type === 'refund.created' || event.type === 'refund.updated'
    || event.type === 'refund.failed' || event.type === 'charge.refund.updated') {
    // PAY-STRIPE-MP card orders: external refunds are recorded on the card order.
    const input = event.type === 'charge.refunded' ? { chargeId: event.data.object.id } : { refundId: event.data.object.id };
    if (await handleCardRefund(supabase, getStripeClient(), input, () => reportPaymentEvidenceConflict(event.type))) return;
    // Still current, not legacy fulfillment: approved credit-pack refund results and ordinary wallet-pack external refunds.
    await reconcileSubscriptionRefundFromStripeWebhook(supabase, event);
    return;
  }
  if (event.type.startsWith('charge.dispute.')) {
    await handlePaymentDispute(supabase, getStripeClient(), event, reportPaymentDispute);
    return;
  }
  // ARCH-FIX F2: the legacy checkout/invoice/subscription fulfillment fallback is closed. Orders created before PAY-STRIPE-MP
  // (10-12) exist only as staging test data; production starts from a new database. An event no current handler claims
  // changes no credits: it is logged and acknowledged so Stripe stops retrying. stripeFulfillment.ts stays for other callers.
  logServerWarn('billing', 'stripe_webhook_unclaimed', { eventType: event.type });
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
