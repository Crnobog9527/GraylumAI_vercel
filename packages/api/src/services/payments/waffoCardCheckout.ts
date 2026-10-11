/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { prepareMethodPurchase, methodPurchaseInputSchema } from './methodPurchase';
import { buildWaffoCheckoutRequest, dispatchWaffoCheckout, WAFFO_CHECKOUT_TTL_SECONDS, type WaffoCheckoutOrder } from './waffoCheckout';
import type { WaffoCheckoutCreate } from './waffoTestOperationsClient';

/** The database admits a checkout window up to 31 minutes; the session itself lives 30. */
const CLAIM_WINDOW_MS = (WAFFO_CHECKOUT_TTL_SECONDS + 60) * 1000;
/** Replay only while the original session can still be open: far inside Waffo's 24-hour key window. */
const REPLAY_MARGIN_MS = 60 * 1000;

/** Release unpaid card orders 40 minutes after checkout started (Owner decision 2026-10-11), so an abandoned
 * checkout does not block the next purchase or hold a founder seat. The database enforces timing. */
export async function closeExpiredWaffoCheckouts(db: Pick<SupabaseClient, 'from' | 'rpc'>, merchant: string, userId?: string) {
  let query = db.from('payment_orders').select('id,user_id').eq('payment_channel', 'waffo').eq('payment_method', 'card')
    .eq('payment_mode', 'test').eq('merchant_namespace', merchant).eq('qualification_state', 'reserved')
    .eq('payment_status', 'unpaid').is('purchase_closed_at', null)
    // Only rows old enough can qualify (dispatch never precedes creation); oldest first so the cap never starves them.
    .lt('created_at', new Date(Date.now() - 40 * 60 * 1000).toISOString()).order('created_at', { ascending: true });
  if (userId) query = query.eq('user_id', userId);
  const due = await query.limit(100);
  if (due.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  let closed = 0;
  for (const row of (due.data ?? []) as { id: string; user_id: string }[]) {
    const result = await db.rpc('pay_waffo_close_card_checkout', { p_user: row.user_id, p_order: row.id, p_merchant: merchant, p_rejected: false });
    if (!result.error) closed += 1;
    else if (!/PAY_WAFFO_CLOSE_DENIED/.test(result.error.message ?? '')) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  }
  return closed;
}

export async function createWaffoCardCheckout(input: {
  db: SupabaseClient; provider: WaffoCheckoutCreate & { merchant: string; mode: 'test' }; userId: string;
  appUrl: string; termsVersion: string; checkoutOrigin: string | undefined;
  purchase: z.infer<typeof methodPurchaseInputSchema>;
}) {
  const { db, provider, userId, purchase } = input;
  if (purchase.method !== 'card' || purchase.itemType !== 'membership_plan') throw new Error('PAY_WAFFO_METHOD_DENIED');
  if (provider.mode !== 'test' || !input.checkoutOrigin) throw new Error('PAY_WAFFO_TEST_CONFIG_UNAVAILABLE');
  await closeExpiredWaffoCheckouts(db, provider.merchant, userId);
  const order = await prepareMethodPurchase({ admin: db, userId, purchase,
    merchantNamespace: provider.merchant, paymentMode: 'test', termsVersion: input.termsVersion });
  const product = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id)
    .eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').eq('object_type', 'price').maybeSingle();
  if (product.error || !product.data) throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
  const providerRequest = buildWaffoCheckoutRequest({ order: order as WaffoCheckoutOrder, productId: product.data.external_id,
    merchantNamespace: provider.merchant, appUrl: input.appUrl });
  const latestExpiry = Date.now() + CLAIM_WINDOW_MS;
  let stored: Record<string, unknown> = providerRequest;
  let claimExpiry = latestExpiry;
  // Waffo replays the original session for the same key (measured). The key is fixed per order, so a
  // timed-out create is recovered by repeating the exact stored request, never by a second checkout.
  const idempotencyKey = `graylum-checkout-${order.id}`;
  const create = async (request: Record<string, unknown>) => {
    try { return await provider.createCheckout(request, idempotencyKey); } catch (error) {
      if (error instanceof Error && error.message === 'PAY_WAFFO_PROVIDER_REJECTED') {
        const closed = await db.rpc('pay_waffo_close_card_checkout', { p_user: userId, p_order: order.id,
          p_merchant: provider.merchant, p_rejected: true });
        if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
      }
      throw error;
    }
  };
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
      claimExpiry = Date.parse(claimed.data.expiresAt);
      return claimed.data.dispatch;
    },
    create,
    // After the window the original session is expired anyway; never POST again (the order is released later).
    recover: async () => (Date.now() < claimExpiry - REPLAY_MARGIN_MS ? create(stored) : null),
    persist: async (result) => {
      const bound = await db.rpc('pay_waffo_bind_checkout', { p_user: userId, p_order: order.id, p_merchant: provider.merchant,
        p_checkout: result.sessionId, p_expires: result.expiresAt });
      if (bound.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    },
    createdAfter: Date.now(), latestExpiry, allowedCheckoutOrigin: input.checkoutOrigin,
  }).catch((error: unknown) => {
    // An expired or mismatched replay is not a new purchase; the order is released after its window.
    if (error instanceof Error && ['PAY_WAFFO_CHECKOUT_CONFLICT', 'PAY_WAFFO_RECONCILIATION_REQUIRED'].includes(error.message)) return null;
    throw error;
  });
  if (!session) return { orderId: order.id, state: 'recovery_required' as const, url: null };
  return { orderId: order.id, state: 'open' as const, url: session.checkoutUrl };
}
