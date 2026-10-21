/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePaymentOrderStatus } from '../paymentOrderStatus';
import { recoverMethodCheckout } from './walletWebhook';

/** Browser return for wallet and PAY-STRIPE-MP card orders: the same recovery as the webhook, never the
 * legacy recording. A browser return is not payment evidence; the original session decides (an open
 * session changes nothing). Returns null for legacy orders. Throws without falling through on failure. */
export async function syncMethodCheckoutReturn(db: SupabaseClient, stripe: Stripe, session: Stripe.Checkout.Session, userId: string) {
  const method = await recoverMethodCheckout(db, stripe, session.id);
  if (!method) return null;
  // The owner check already matched this session to the signed-in user; it must belong to one of our orders.
  if (!method.orderId) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const synced = await db.from('payment_orders').select('status,fulfilled_at,payment_method').eq('id', method.orderId).eq('user_id', userId).maybeSingle();
  if (synced.error || !synced.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE', { cause: synced.error });
  // Report the session as the recovery saw it: payment may have completed after the caller's own read, and a paid
  // order kept for review must not read as "no charge".
  return { sessionId: session.id, paymentMethod: (synced.data.payment_method as string | null) ?? null,
    mode: session.mode, checkoutStatus: method.checkoutStatus ?? session.status,
    paymentStatus: method.paymentStatus ?? session.payment_status,
    orderStatus: synced.data.status ? normalizePaymentOrderStatus(synced.data.status) : null,
    fulfilledAt: (synced.data.fulfilled_at as string | null) ?? null, stripeSubscriptionId: null, stripeInvoiceId: null };
}

/** A paid session found again by a new checkout request: wallet and card orders take their own recovery
 * (the legacy validators refuse discounted or taxed Managed Payments invoices); only legacy orders run `legacy`. */
export async function fulfillRecoveredPaidCheckout(db: SupabaseClient, stripe: Stripe, session: Stripe.Checkout.Session,
  userId: string, legacy: () => Promise<unknown>) {
  if (!await syncMethodCheckoutReturn(db, stripe, session, userId)) await legacy();
}
