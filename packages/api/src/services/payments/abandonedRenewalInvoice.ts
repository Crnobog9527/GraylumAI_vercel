/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';

const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;

/** Owner 2026-10-24 (A): after every retry of a renewal fails, Stripe cancels the subscription but leaves that
 * renewal invoice open for good. Refund evidence may skip such an invoice only when all three hold: nothing was paid,
 * Stripe has no further attempt scheduled, and its subscription is canceled (read from Stripe now, not from our
 * records). Anything else, including the same invoice once the buyer pays it, still has to be resolved. The invoice
 * is read again after the subscription, so a payment that lands between the list and this check is not missed. */
export async function isAbandonedRenewalInvoice(stripe: Pick<Stripe, 'subscriptions' | 'invoices'>, invoice: Stripe.Invoice,
  live: boolean) {
  const subscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
  const abandoned = (row: Stripe.Invoice) => row.id === invoice.id && row.status === 'open' && row.amount_paid === 0
    && row.next_payment_attempt == null && row.livemode === live
    && objectId(row.parent?.subscription_details?.subscription) === subscriptionId;
  if (!subscriptionId || !abandoned(invoice)) return false;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.id !== subscriptionId || subscription.livemode !== live || subscription.status !== 'canceled') return false;
  return abandoned(await stripe.invoices.retrieve(invoice.id));
}
