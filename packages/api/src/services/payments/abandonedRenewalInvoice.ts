/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';

const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;

/** Owner 2026-10-24 (A): after every retry of a renewal fails, Stripe cancels the subscription but leaves that
 * renewal invoice open for good. Refund evidence may skip such an invoice only when all three hold: nothing was paid,
 * Stripe has no further attempt scheduled, and its subscription is canceled (read from Stripe now, not from our
 * records). Anything else, including the same invoice once the buyer pays it, still has to be resolved. */
export async function isAbandonedRenewalInvoice(stripe: Pick<Stripe, 'subscriptions'>, invoice: Stripe.Invoice, live: boolean) {
  if (invoice.status !== 'open' || invoice.amount_paid !== 0 || invoice.next_payment_attempt != null
    || invoice.livemode !== live) return false;
  const subscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return false;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  return subscription.id === subscriptionId && subscription.livemode === live && subscription.status === 'canceled';
}
