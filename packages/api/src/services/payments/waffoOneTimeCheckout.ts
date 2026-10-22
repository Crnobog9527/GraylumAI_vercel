/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import { prepareMethodPurchase, methodPurchaseInputSchema } from './methodPurchase';
import { buildWaffoOneTimeCheckoutRequest, dispatchWaffoCheckout, WAFFO_CHECKOUT_TTL_SECONDS, type WaffoCheckoutOrder } from './waffoCheckout';
import type { WaffoOperationsClient } from './waffoTestOperationsClient';
import { freezePurchaseSnapshot } from './contracts';
import { majorToCents, snapshotAmountDue } from './purchaseFacts';
import { recoverWaffoOneTimeCheckouts } from './waffoOneTimeRecovery';
import { closeExpiredWaffoCheckouts } from './waffoCardCheckout';

/** The source order is committed before dispatch. Unknown creates stay blocked until their original
 * checkout window closes; creating another independently payable Waffo session is never recovery. */
export async function createWaffoOneTimeCheckout(input: {
  db: SupabaseClient; provider: Pick<WaffoOperationsClient, 'merchant' | 'mode' | 'storeId' | 'createCheckout' | 'readOneTimeProduct'
    | 'findOneTimeOrders' | 'findOrderPayments' | 'readChargebacks'>;
  userId: string; appUrl: string; termsVersion: string; checkoutOrigin: string | undefined;
  purchase: z.infer<typeof methodPurchaseInputSchema>;
}) {
  const { db, provider, purchase, userId } = input;
  if (!['card', 'card_cn', 'alipay'].includes(purchase.method) || !input.checkoutOrigin) throw new Error('PAY_WAFFO_METHOD_DENIED');
  await recoverWaffoOneTimeCheckouts(db, provider, userId);
  await closeExpiredWaffoCheckouts(db, provider.merchant, userId, provider.mode);
  const order = await prepareMethodPurchase({ admin: db, userId, purchase,
    merchantNamespace: provider.merchant, paymentMode: provider.mode, termsVersion: input.termsVersion });
  let providerRequest: ReturnType<typeof buildWaffoOneTimeCheckoutRequest>;
  try {
    const product = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id)
      .eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', provider.mode).eq('object_type', 'price').maybeSingle();
    if (product.error || !product.data) throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
    const snapshot = freezePurchaseSnapshot(order.purchase_snapshot);
    // A mislabelled recurring product must fail before creating any payable checkout.
    const actual = await provider.readOneTimeProduct(product.data.external_id);
    const usd = actual.prices?.filter(price => price.currency === 'USD') ?? [];
    let validPrice = false;
    try { validPrice = usd.length === 1 && usd[0]!.priceInfo.taxCategory === 'saas'
      && majorToCents(usd[0]!.priceInfo.amount) === majorToCents(snapshot.price)
      && order.amount_total === snapshotAmountDue(snapshot) && snapshot.tax_behavior === 'inclusive'; } catch { /* unknown price stays closed */ }
    if (actual.id !== product.data.external_id || actual.storeId !== provider.storeId || actual.status !== 'active' || !validPrice) {
      throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
    }
    providerRequest = buildWaffoOneTimeCheckoutRequest({ order: order as WaffoCheckoutOrder,
      productId: product.data.external_id, merchantNamespace: provider.merchant, appUrl: input.appUrl });
  } catch (error) {
    // Only an order that still has no dispatch claim may close here; concurrent/in-flight dispatch stays blocked.
    const closed = await db.rpc('pay_waffo_abort_before_dispatch', { p_user: userId, p_order: order.id,
      p_merchant: provider.merchant, p_expected: null });
    if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    throw error;
  }
  const latestExpiry = Date.now() + (WAFFO_CHECKOUT_TTL_SECONDS + 60) * 1000;
  const session = await dispatchWaffoCheckout({ request: providerRequest,
    claimDispatch: async () => {
      const claimed = await db.rpc('pay_waffo_claim_checkout', { p_user: userId, p_order: order.id, p_merchant: provider.merchant,
        p_expires: new Date(latestExpiry).toISOString(), p_request: { orderId: order.id, userId, method: purchase.method,
          merchant: provider.merchant, mode: provider.mode, purchaseMode: 'payment', providerRequest } });
      if (claimed.error || typeof claimed.data?.dispatch !== 'boolean' || !claimed.data?.request?.providerRequest) {
        throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
      }
      return claimed.data.dispatch;
    },
    create: async request => {
      try { return await provider.createCheckout(request, `graylum-checkout-${order.id}`); }
      catch (error) {
        if (error instanceof Error && error.message === 'PAY_WAFFO_PROVIDER_REJECTED') {
          const closed = await db.rpc('pay_waffo_close_card_checkout', { p_user: userId, p_order: order.id,
            p_merchant: provider.merchant, p_rejected: true });
          if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
        }
        throw error;
      }
    },
    recover: async () => null,
    persist: async result => {
      const bound = await db.rpc('pay_waffo_bind_checkout', { p_user: userId, p_order: order.id, p_merchant: provider.merchant,
        p_checkout: result.sessionId, p_expires: result.expiresAt });
      if (bound.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    },
    createdAfter: Date.now(), latestExpiry, allowedCheckoutOrigin: input.checkoutOrigin,
  }).catch((error: unknown) => {
    if (error instanceof Error && ['PAY_WAFFO_CHECKOUT_CONFLICT', 'PAY_WAFFO_RECONCILIATION_REQUIRED'].includes(error.message)) return null;
    throw error;
  });
  if (!session) return { orderId: order.id, state: 'recovery_required' as const, url: null };
  return { orderId: order.id, state: 'open' as const, url: session.checkoutUrl };
}
