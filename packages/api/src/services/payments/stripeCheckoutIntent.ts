/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { freezePurchaseSnapshot } from './contracts';
import { assertPurchaseReceipt, checkoutIdempotencyKey, majorToCents, snapshotAmountDue, type StripeScope } from './purchaseFacts';
import { assertStripePurchasePrice } from './stripePurchaseEvidence';

/** PAY-STRIPE-MP card checkout: `card` uses Managed Payments, `card_cn` plain Stripe. A discounted
 * subscription is only ever the server-selected first-month coupon on the plan's standard price. */
export type StripeCardCheckout = Readonly<{ managedPayments: boolean; couponId?: string }>;

export type StripeCheckoutIntent = {
  id: string;
  userId: string;
  scope: StripeScope;
  snapshot: unknown;
  priceId: string;
  // Persisted atomically with the order, before the first provider call. Never rebuild a retry
  // from a current catalog, profile or request origin. No secrets or personal details are stored.
  request: Stripe.Checkout.SessionCreateParams;
  sessionId: string | null;
  recover?: boolean;
  walletMethod?: 'wechat_pay' | 'alipay';
  card?: StripeCardCheckout;
};

type MethodParams = Pick<Stripe.Checkout.SessionCreateParams,
  'payment_method_types' | 'payment_method_options' | 'managed_payments' | 'billing_address_collection'>;
function paymentMethodParams(input: { recurring: boolean; walletMethod?: 'wechat_pay' | 'alipay'; card?: StripeCardCheckout }): MethodParams {
  if (input.walletMethod) {
    return { payment_method_types: [input.walletMethod],
      ...(input.walletMethod === 'wechat_pay' ? { payment_method_options: { wechat_pay: { client: 'web' as const } } } : {}) };
  }
  // Managed Payments rejects payment_method_types; Stripe chooses the methods and adds tax at checkout.
  if (input.card?.managedPayments) return { managed_payments: { enabled: true } };
  // Mainland card: no Managed Payments; the billing country stays on the order for later review.
  if (input.card) return { payment_method_types: ['card'], billing_address_collection: 'required' as const };
  return { payment_method_types: input.recurring ? ['card'] : ['card', 'alipay'] };
}

export function buildStripeCheckoutRequest(input: {
  orderId: string;
  userId: string;
  snapshot: unknown;
  priceId: string;
  productName: string;
  appUrl: string;
  expiresAt: number;
  walletMethod?: 'wechat_pay' | 'alipay';
  card?: StripeCardCheckout;
}): Stripe.Checkout.SessionCreateParams {
  const snapshot = freezePurchaseSnapshot(input.snapshot);
  const amount = snapshotAmountDue(snapshot);
  const recurring = snapshot.item_type === 'membership_plan' && !input.walletMethod;
  const discounted = majorToCents(snapshot.discount) !== 0;
  const coupon = input.card?.couponId;
  if (input.card && input.walletMethod) throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
  if (recurring && discounted && !coupon) throw new Error('PAY_COMMON_SUBSCRIPTION_DISCOUNT_UNSUPPORTED');
  if (coupon !== undefined && (!recurring || !discounted || !/^[A-Za-z0-9_-]{1,200}$/.test(coupon))) {
    throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
  }
  const origin = new URL(input.appUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || !Number.isSafeInteger(input.expiresAt)) throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
  const metadata = {
    orderId: input.orderId, userId: input.userId, itemId: snapshot.item_id,
    itemType: snapshot.item_type, billingCycle: snapshot.billing_cycle, priceId: input.priceId,
  };
  const lineItem: NonNullable<Stripe.Checkout.SessionCreateParams['line_items']>[number] = !discounted || coupon
    ? { price: input.priceId, quantity: 1 }
    : { price_data: { currency: snapshot.currency, unit_amount: amount,
      product_data: { name: input.productName } }, quantity: 1 };
  return {
    mode: recurring ? 'subscription' : 'payment',
    ...paymentMethodParams({ recurring, walletMethod: input.walletMethod, card: input.card }),
    ...(recurring || input.card?.managedPayments ? {} : { customer_creation: 'always' }),
    client_reference_id: input.userId,
    line_items: [lineItem],
    ...(coupon ? { discounts: [{ coupon }] } : {}),
    expires_at: input.expiresAt,
    success_url: `${origin.origin}/app/profile?tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin.origin}/app/profile?tab=subscription&checkout=canceled&session_id={CHECKOUT_SESSION_ID}`,
    metadata,
    ...(recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  };
}

const METHOD_KEYS = ['payment_method_types', 'payment_method_options', 'managed_payments', 'billing_address_collection'] as const;
function sameMethodParams(request: Stripe.Checkout.SessionCreateParams, expected: MethodParams) {
  return METHOD_KEYS.every(key => JSON.stringify(request[key] ?? null) === JSON.stringify(expected[key] ?? null));
}

/** Stripe tax code for AI-as-a-service, personal use: required on every Managed Payments product. */
export const MANAGED_PAYMENTS_TAX_CODE = 'txcd_10105001';

/** The first-month coupon must take exactly the snapshot discount off one invoice, nothing else. */
export function assertFirstMonthCoupon(coupon: Stripe.Coupon, input: {
  couponId: string; snapshot: unknown; scope: StripeScope; productId: string | null;
}) {
  const snapshot = freezePurchaseSnapshot(input.snapshot);
  const products = coupon.applies_to?.products;
  if (coupon.id !== input.couponId || coupon.object !== 'coupon' || !coupon.valid || coupon.livemode !== (input.scope.mode === 'live')
    || coupon.percent_off !== null || coupon.amount_off !== majorToCents(snapshot.discount) || coupon.currency !== snapshot.currency
    || coupon.duration !== 'once' || (products && (!input.productId || !products.includes(input.productId)))) {
    throw new Error('PAY_COMMON_PRICE_MISMATCH');
  }
  return coupon;
}

// Only a complete scoped scan can prove absence. An incomplete scan always requires reconciliation.
export const CHECKOUT_ABSENCE_GRACE_SECONDS = 3600;
async function findOriginalCheckout(stripe: Pick<Stripe, 'checkout'>, intent: StripeCheckoutIntent) {
  const expiry = intent.request.expires_at;
  if (!Number.isSafeInteger(expiry)) throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
  return findCheckoutForOrder(stripe, intent.id, expiry! - 24 * 3600, expiry!);
}

/** The order's Session created in [from, to] (unix seconds), or null after a complete scan of that window. */
export async function findCheckoutForOrder(stripe: Pick<Stripe, 'checkout'>, orderId: string, from: number, to: number) {
  let cursor: string | undefined;
  let found: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await stripe.checkout.sessions.list({ limit: 100,
      created: { gte: from, lte: to }, ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean') {
      throw new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
    }
    for (const session of result.data) {
      if (session.metadata?.orderId !== orderId) continue;
      if (found && found !== session.id) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
      found = session.id;
    }
    if (!result.has_more) return found ? stripe.checkout.sessions.retrieve(found) : null;
    const next = result.data.at(-1)?.id;
    if (!next || next === cursor) break;
    cursor = next;
  }
  throw new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
}

// Checkout adapter entry: admission and request persistence must precede this call.
// Persisting a provider result is a separate short database transaction; no lock spans the network.
export async function dispatchStripeCheckoutIntent(input: {
  stripe: Pick<Stripe, 'prices' | 'checkout'> & Partial<Pick<Stripe, 'coupons'>>;
  intent: StripeCheckoutIntent;
  scope: StripeScope;
  persistSession: (session: Stripe.Checkout.Session) => Promise<void>;
  now?: number;
  createIfMissing?: boolean;
  closeNeverCreated?: () => Promise<void>;
  // Only the fresh claim owner may prove no Session-create request has been sent.
  closeBeforeDispatch?: () => Promise<void>;
}) {
  const { stripe, intent, scope } = input;
  let mayAbort = input.createIfMissing === true && !intent.recover && !intent.sessionId && Boolean(input.closeBeforeDispatch);
  try {
    checkoutIdempotencyKey(intent.id);
    if (intent.scope.merchant !== scope.merchant || intent.scope.mode !== scope.mode
      || intent.request.metadata?.orderId !== intent.id || intent.request.metadata?.userId !== intent.userId
      || intent.request.client_reference_id !== intent.userId) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
    if (intent.walletMethod && (intent.request.payment_method_types?.length !== 1
      || intent.request.payment_method_types[0] !== intent.walletMethod)) throw new Error('PAY_WAFFO_METHOD_DENIED');
    const snapshot = freezePurchaseSnapshot(intent.snapshot);
    const item = intent.request.line_items?.[0];
    const discounted = majorToCents(snapshot.discount) !== 0;
    const recurring = snapshot.item_type === 'membership_plan' && !intent.walletMethod;
    const coupon = intent.card?.couponId;
    if ((intent.card && intent.walletMethod) || (coupon !== undefined && (!recurring || !discounted))
      || !sameMethodParams(intent.request, paymentMethodParams({ recurring, walletMethod: intent.walletMethod, card: intent.card }))
      || JSON.stringify(intent.request.discounts ?? null) !== JSON.stringify(coupon ? [{ coupon }] : null)) {
      throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    }
    if (intent.request.mode !== (recurring ? 'subscription' : 'payment')
      || intent.request.metadata?.itemId !== snapshot.item_id || intent.request.metadata?.itemType !== snapshot.item_type
      || intent.request.metadata?.billingCycle !== snapshot.billing_cycle || intent.request.metadata?.priceId !== intent.priceId
      || intent.request.line_items?.length !== 1 || item?.quantity !== 1
      || (discounted && !coupon ? item.price_data?.unit_amount !== snapshotAmountDue(snapshot)
        || item.price_data.currency !== snapshot.currency || Boolean(item.price)
        : item.price !== intent.priceId || Boolean(item.price_data))) {
      throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    }
    let session: Stripe.Checkout.Session;
    if (intent.sessionId) {
      session = await stripe.checkout.sessions.retrieve(intent.sessionId);
    } else {
      // Stripe may prune idempotency keys after 24h. A persisted absolute expiry prevents an old
      // attempt from becoming a fresh charge after that window, even after process restart.
      const now = input.now ?? Math.floor(Date.now() / 1000);
      const recovered = intent.recover || input.createIfMissing === false || (intent.request.expires_at ?? 0) <= now
        ? await findOriginalCheckout(stripe, intent) : null;
      if (recovered) { mayAbort = false; session = recovered; }
      else {
        if (Number.isSafeInteger(intent.request.expires_at)
          && now >= intent.request.expires_at! + CHECKOUT_ABSENCE_GRACE_SECONDS && input.closeNeverCreated) {
          mayAbort = false;
          await input.closeNeverCreated();
          return null;
        }
        if (input.createIfMissing === false || !Number.isSafeInteger(intent.request.expires_at) || intent.request.expires_at! <= now) {
          throw new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
        }
        const managed = intent.card?.managedPayments === true;
        const price = managed ? await stripe.prices.retrieve(intent.priceId, { expand: ['product'] })
          : await stripe.prices.retrieve(intent.priceId);
        assertStripePurchasePrice({ price, priceId: intent.priceId, snapshot: intent.snapshot, scope, walletMethod: intent.walletMethod,
          ...(managed ? { taxCode: MANAGED_PAYMENTS_TAX_CODE } : {}) });
        if (coupon) {
          if (!stripe.coupons) throw new Error('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
          assertFirstMonthCoupon(await stripe.coupons.retrieve(coupon), { couponId: coupon, snapshot: intent.snapshot, scope,
            productId: typeof price.product === 'string' ? price.product : price.product?.id ?? null });
        }
        if ((intent.walletMethod || intent.card) && input.closeBeforeDispatch
          && intent.request.expires_at! - Math.floor(Date.now() / 1000) < 30 * 60 + 15) {
          mayAbort = false;
          await input.closeBeforeDispatch();
          return null;
        }
        mayAbort = false; // Any failure from this point may have created a provider Session.
        session = await stripe.checkout.sessions.create(intent.request, { idempotencyKey: checkoutIdempotencyKey(intent.id),
          ...(intent.walletMethod ? { timeout: 10000, maxNetworkRetries: 0 } : {}),
        });
      }
    }
    if (session.object !== 'checkout.session' || session.livemode !== (scope.mode === 'live')
      || session.metadata?.orderId !== intent.id || session.metadata?.userId !== intent.userId
      || session.client_reference_id !== intent.userId || (intent.sessionId && session.id !== intent.sessionId)) {
      throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
    }
    assertPurchaseReceipt({ snapshot, amount: session.amount_total, tax: session.total_details?.amount_tax,
      currency: session.currency, livemode: session.livemode, scope });
    if (session.mode !== intent.request.mode
      || (intent.card && (session.managed_payments?.enabled ?? false) !== intent.card.managedPayments)) {
      throw new Error('PAY_COMMON_RECEIPT_MISMATCH');
    }
    await input.persistSession(session);
    return session;
  } catch (error) {
    if (mayAbort && input.closeBeforeDispatch) await input.closeBeforeDispatch();
    throw error;
  }
}
