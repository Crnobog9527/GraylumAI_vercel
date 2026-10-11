/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { prepareMethodPurchase, methodPurchaseInputSchema } from './methodPurchase';
import { buildWaffoCheckoutRequest, dispatchWaffoCheckout, WAFFO_CHECKOUT_TTL_SECONDS, type WaffoCheckoutOrder } from './waffoCheckout';
import type { WaffoCheckoutCreate } from './waffoTestOperationsClient';

/** The database admits a checkout window up to 31 minutes; the session itself lives 30. */
const CLAIM_WINDOW_MS = (WAFFO_CHECKOUT_TTL_SECONDS + 60) * 1000;

export async function createWaffoCardCheckout(input: {
  db: SupabaseClient; provider: WaffoCheckoutCreate & { merchant: string; mode: 'test' }; userId: string;
  appUrl: string; termsVersion: string; checkoutOrigin: string | undefined;
  purchase: z.infer<typeof methodPurchaseInputSchema>;
}) {
  const { db, provider, userId, purchase } = input;
  if (purchase.method !== 'card' || purchase.itemType !== 'membership_plan') throw new Error('PAY_WAFFO_METHOD_DENIED');
  if (provider.mode !== 'test' || !input.checkoutOrigin) throw new Error('PAY_WAFFO_TEST_CONFIG_UNAVAILABLE');
  const order = await prepareMethodPurchase({ admin: db, userId, purchase,
    merchantNamespace: provider.merchant, paymentMode: 'test', termsVersion: input.termsVersion });
  const product = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id)
    .eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').eq('object_type', 'price').maybeSingle();
  if (product.error || !product.data) throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
  const providerRequest = buildWaffoCheckoutRequest({ order: order as WaffoCheckoutOrder, productId: product.data.external_id,
    merchantNamespace: provider.merchant, appUrl: input.appUrl });
  const latestExpiry = Date.now() + CLAIM_WINDOW_MS;
  let stored: Record<string, unknown> = providerRequest;
  // Waffo replays the original session for the same key (measured). The key is fixed per order, so a
  // timed-out create is recovered by repeating the exact stored request, never by a second checkout.
  const idempotencyKey = `graylum-checkout-${order.id}`;
  const session = await dispatchWaffoCheckout({
    request: providerRequest,
    claimDispatch: async () => {
      const claimed = await db.rpc('pay_waffo_claim_checkout', { p_user: userId, p_order: order.id, p_merchant: provider.merchant,
        p_expires: new Date(latestExpiry).toISOString(), p_request: { orderId: order.id, userId, method: 'card',
          merchant: provider.merchant, mode: 'test', providerRequest } });
      if (claimed.error || typeof claimed.data?.dispatch !== 'boolean' || !claimed.data?.request?.providerRequest) {
        throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
      }
      stored = claimed.data.request.providerRequest;
      return claimed.data.dispatch;
    },
    create: request => provider.createCheckout(request, idempotencyKey),
    recover: () => provider.createCheckout(stored, idempotencyKey),
    persist: async (result) => {
      const bound = await db.rpc('pay_waffo_bind_checkout', { p_user: userId, p_order: order.id, p_merchant: provider.merchant,
        p_checkout: result.sessionId, p_expires: result.expiresAt });
      if (bound.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    },
    createdAfter: Date.now(), latestExpiry, allowedCheckoutOrigin: input.checkoutOrigin,
  }).catch((error: unknown) => {
    // An expired or mismatched replay is not a new purchase; the order stays for reconciliation.
    if (error instanceof Error && error.message === 'PAY_WAFFO_CHECKOUT_CONFLICT') return null;
    throw error;
  });
  if (!session) return { orderId: order.id, state: 'recovery_required' as const, url: null };
  return { orderId: order.id, state: 'open' as const, url: session.checkoutUrl };
}
