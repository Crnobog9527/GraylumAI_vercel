/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { freezePurchaseSnapshot } from './contracts';
import { prepareMethodPurchase, methodPurchaseInputSchema } from './methodPurchase';
import { majorToCents } from './purchaseFacts';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { buildStripeCheckoutRequest, dispatchStripeCheckoutIntent, type StripeCardCheckout } from './stripeCheckoutIntent';
import { observeUpgradePrior } from './cardUpgrade';

type Input = {
  db: SupabaseClient; stripe: Stripe; userId: string; appUrl: string; termsVersion: string;
  purchase: z.infer<typeof methodPurchaseInputSchema>;
};
type Order = { id: string; item_id: string; price_ref_id: string; purchase_snapshot: unknown;
  method_dispatched_at?: string | null; checkout_request?: { providerRequest?: Stripe.Checkout.SessionCreateParams } | null };

/** The plan's current first-month coupon, read from the same mapping 0222 admission required. */
async function currentFirstMonthCoupon(db: SupabaseClient, merchant: string, order: Order) {
  const coupon = await db.from('payment_provider_refs').select('external_id').eq('channel', 'stripe')
    .eq('merchant_namespace', merchant).eq('mode', 'test').eq('object_type', 'coupon').eq('offer_kind', 'gold_first30')
    .eq('membership_plan_id', order.item_id).eq('billing_cycle', 'monthly').eq('is_current', true).maybeSingle();
  if (coupon.error || !coupon.data) throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
  return coupon.data.external_id as string;
}

/** The coupon frozen into the claimed request; a recovery must look for the session it was created with. */
function frozenCoupon(request: Stripe.Checkout.SessionCreateParams) {
  const discounts = request.discounts;
  if (discounts === undefined) return undefined;
  if (!Array.isArray(discounts) || discounts.length !== 1 || typeof discounts[0]?.coupon !== 'string') {
    throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  }
  return discounts[0].coupon;
}

function assertSessionMethod(session: Stripe.Checkout.Session, purchase: Input['purchase']) {
  const types = session.payment_method_types;
  const managed = session.managed_payments?.enabled === true;
  const ok = purchase.method === 'card' ? managed
    : purchase.method === 'card_cn' ? !managed && types.length === 1 && types[0] === 'card'
      : !managed && types.length === 1 && types[0] === purchase.method;
  if (!ok) throw new Error('PAY_WAFFO_METHOD_DENIED');
}

/** New-method Stripe checkout (wallet one-time, card/card_cn). Admission, request freeze and claim
 * precede the provider call; a retry recovers the frozen request instead of rebuilding it. */
export async function createStripeMethodCheckout(input: Input) {
  const { db, stripe, userId, purchase } = input;
  const scope = await resolveStripeScope(stripe);
  if (scope.mode !== 'test') throw new Error('PAY_WAFFO_LIVE_DISABLED');
  const order = await prepareMethodPurchase({ admin: db, userId, purchase,
    merchantNamespace: scope.merchant, paymentMode: scope.mode, termsVersion: input.termsVersion }) as Order;
  const price = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id)
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', 'test').eq('object_type', 'price').maybeSingle();
  if (price.error || !price.data) throw new Error('PAY_WAFFO_PRICE_UNAVAILABLE');
  const isCard = purchase.method === 'card' || purchase.method === 'card_cn';
  const walletMethod = isCard ? undefined : purchase.method as 'wechat_pay' | 'alipay';
  // An already dispatched order is recovered from its frozen request, never from the current catalog: the
  // coupon mapping may have rotated or been rolled back since. Only a fresh claim reads the current coupon.
  const dispatched = order.method_dispatched_at ? order.checkout_request?.providerRequest : undefined;
  const snapshot = isCard && !dispatched ? freezePurchaseSnapshot(order.purchase_snapshot) : null;
  // Only a card subscription can be discounted (0222 first month); the request builder refuses anything else.
  const couponId = snapshot?.item_type === 'membership_plan' && majorToCents(snapshot.discount) !== 0
    ? await currentFirstMonthCoupon(db, scope.merchant, order).catch(async (error: unknown) => {
      // Never claimed, so nothing reached Stripe: release the reservation instead of blocking every retry.
      const released = await db.rpc('pay_waffo_abort_before_dispatch', { p_user: userId, p_order: order.id,
        p_merchant: scope.merchant, p_expected: null });
      if (released.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE', { cause: released.error });
      throw error;
    }) : undefined;
  const cardFor = (coupon: string | undefined): StripeCardCheckout | undefined => isCard
    ? { managedPayments: purchase.method === 'card', ...(coupon ? { couponId: coupon } : {}) } : undefined;
  // Stripe requires 30 minutes after creation: reserve one minute for dispatch.
  // The database includes all 31 minutes in the frozen upgrade safety cutoff.
  const expiresAt = Math.floor(Date.now() / 1000) + 31 * 60;
  const proposed = dispatched ?? buildStripeCheckoutRequest({ orderId: order.id, userId, snapshot: order.purchase_snapshot,
    priceId: price.data.external_id, productName: 'Membership / Credits', appUrl: input.appUrl, expiresAt, walletMethod,
    card: cardFor(couponId) });
  const claimed = await db.rpc('pay_waffo_claim_checkout', { p_user: userId, p_order: order.id, p_merchant: scope.merchant,
    p_expires: new Date(expiresAt * 1000).toISOString(), p_request: { orderId: order.id, userId, method: purchase.method,
      merchant: scope.merchant, mode: 'test', providerRequest: proposed } });
  if (claimed.error || typeof claimed.data?.dispatch !== 'boolean' || !claimed.data?.request?.providerRequest) {
    throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  }
  // A fresh claim froze the request just built; a recovered claim keeps the coupon it was dispatched with,
  // even if the current mapping rotated since. Recovery never creates a new Session (createIfMissing=false).
  const frozen = frozenCoupon(claimed.data.request.providerRequest);
  if (claimed.data.dispatch && frozen !== couponId) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  const card = cardFor(claimed.data.dispatch ? couponId : frozen);
  const closeBeforeDispatch = claimed.data.dispatch ? async () => {
    const closed = await db.rpc('pay_waffo_abort_before_dispatch', { p_user: userId, p_order: order.id,
      p_merchant: scope.merchant, p_expected: new Date(claimed.data.request.providerRequest.expires_at * 1000).toISOString() });
    if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  } : undefined;
  const mapped = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id).eq('object_type', 'checkout')
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', 'test').maybeSingle().then(
      result => result, () => ({ data: null, error: new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE') }));
  if (mapped.error) {
    if (closeBeforeDispatch) await closeBeforeDispatch();
    throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  }
  const session = await dispatchStripeCheckoutIntent({ stripe, scope, createIfMissing: claimed.data.dispatch,
    intent: { id: order.id, userId, scope, snapshot: order.purchase_snapshot, priceId: price.data.external_id,
      request: claimed.data.request.providerRequest, sessionId: mapped.data?.external_id ?? null,
      walletMethod, card, recover: !claimed.data.dispatch },
    closeBeforeDispatch,
    closeNeverCreated: async () => {
      const closed = await db.rpc('pay_waffo_close_uncreated', { p_user: userId, p_order: order.id, p_merchant: scope.merchant });
      if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    },
    persistSession: async (result) => {
      assertSessionMethod(result, purchase);
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

export async function createStripeCardCheckout(input: Input) {
  if (input.purchase.method !== 'card' && input.purchase.method !== 'card_cn') throw new Error('PAY_WAFFO_METHOD_DENIED');
  // Upgrade of a renewing card Pro: admission needs a fresh provider observation of it (0251).
  if (input.purchase.transition === 'upgrade' && input.purchase.priorSubscriptionId) {
    await observeUpgradePrior(input.db, input.stripe, input.userId, input.purchase.priorSubscriptionId);
  }
  return createStripeMethodCheckout(input);
}
