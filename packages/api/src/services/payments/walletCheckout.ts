/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { prepareMethodPurchase, methodPurchaseInputSchema } from './methodPurchase';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { buildStripeCheckoutRequest, dispatchStripeCheckoutIntent } from './stripeCheckoutIntent';

export async function createWalletCheckout(input: {
  db: SupabaseClient; stripe: Stripe; userId: string; appUrl: string; termsVersion: string;
  purchase: z.infer<typeof methodPurchaseInputSchema>;
}) {
  const { db, stripe, userId, purchase } = input;
  if (purchase.method === 'card') throw new Error('PAY_WAFFO_METHOD_DENIED');
  const scope = await resolveStripeScope(stripe);
  if (scope.mode !== 'test') throw new Error('PAY_WAFFO_LIVE_DISABLED');
  const order = await prepareMethodPurchase({ admin: db, userId, purchase,
    merchantNamespace: scope.merchant, paymentMode: scope.mode, termsVersion: input.termsVersion });
  const price = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id)
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', 'test').eq('object_type', 'price').maybeSingle();
  if (price.error || !price.data) throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
  // Stripe requires 30 minutes after creation: reserve one minute for dispatch.
  // The database includes all 31 minutes in the frozen upgrade safety cutoff.
  const expiresAt = Math.floor(Date.now() / 1000) + 31 * 60;
  const proposed = buildStripeCheckoutRequest({ orderId: order.id, userId, snapshot: order.purchase_snapshot,
    priceId: price.data.external_id, productName: 'Membership / Credits', appUrl: input.appUrl, expiresAt, walletMethod: purchase.method });
  const claimed = await db.rpc('pay_waffo_claim_checkout', { p_user: userId, p_order: order.id, p_merchant: scope.merchant,
    p_expires: new Date(expiresAt * 1000).toISOString(), p_request: { orderId: order.id, userId, method: purchase.method,
      merchant: scope.merchant, mode: 'test', providerRequest: proposed } });
  if (claimed.error || typeof claimed.data?.dispatch !== 'boolean' || !claimed.data?.request?.providerRequest) {
    throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  }
  const mapped = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id).eq('object_type', 'checkout')
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', 'test').maybeSingle();
  if (mapped.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  const session = await dispatchStripeCheckoutIntent({ stripe, scope, createIfMissing: claimed.data.dispatch,
    intent: { id: order.id, userId, scope, snapshot: order.purchase_snapshot, priceId: price.data.external_id,
      request: claimed.data.request.providerRequest, sessionId: mapped.data?.external_id ?? null,
      walletMethod: purchase.method, recover: !claimed.data.dispatch },
    closeBeforeDispatch: claimed.data.dispatch ? async () => {
      const closed = await db.rpc('pay_waffo_abort_before_dispatch', { p_user: userId, p_order: order.id,
        p_merchant: scope.merchant, p_expected: new Date(claimed.data.request.providerRequest.expires_at * 1000).toISOString() });
      if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    } : undefined,
    closeNeverCreated: async () => {
      const closed = await db.rpc('pay_waffo_close_uncreated', { p_user: userId, p_order: order.id, p_merchant: scope.merchant });
      if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    },
    persistSession: async (result) => {
      if (result.payment_method_types.length !== 1 || result.payment_method_types[0] !== purchase.method) {
        throw new Error('PAY_WAFFO_METHOD_DENIED');
      }
      const bound = await db.rpc('pay_waffo_bind_checkout', { p_user: userId, p_order: order.id, p_merchant: scope.merchant,
        p_checkout: result.id, p_expires: new Date(result.expires_at * 1000).toISOString() });
      if (bound.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    },
  });
  if (!session || session.status !== 'open' || !session.url) return { orderId: order.id, state: 'recovery_required' as const, url: null };
  const url = new URL(session.url);
  if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) throw new Error('PAY_WAFFO_CHECKOUT_URL_INVALID');
  return { orderId: order.id, state: 'open' as const, url: url.href };
}
