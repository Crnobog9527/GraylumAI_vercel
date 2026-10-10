/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { freezePurchaseSnapshot } from './contracts';
import { snapshotAmountDue } from './purchaseFacts';

export const WAFFO_CHECKOUT_TTL_SECONDS = 30 * 60;
const sessionSchema = z.object({
  sessionId: z.string().regex(/^cs_[a-f0-9-]{36}$/), checkoutUrl: z.string().url(), expiresAt: z.string().datetime(),
});
export type WaffoCheckoutOrder = {
  id: string; user_id: string; payment_mode: 'test' | 'live'; payment_channel: string;
  payment_method: string; offer_kind: string; purchase_snapshot: unknown;
};

export function buildWaffoCheckoutRequest(input: {
  order: WaffoCheckoutOrder; productId: string; merchantNamespace: string; appUrl: string;
}) {
  const { order } = input;
  const snapshot = freezePurchaseSnapshot(order.purchase_snapshot);
  const origin = new URL(input.appUrl);
  if (order.payment_mode !== 'test' || order.payment_channel !== 'waffo' || order.payment_method !== 'card'
    || snapshot.item_type !== 'membership_plan' || snapshot.currency !== 'usd'
    || origin.protocol !== 'https:' || origin.username || origin.password
    || !/^PROD_[A-Za-z0-9]+$/.test(input.productId) || !z.string().uuid().safeParse(order.id).success
    || !z.string().uuid().safeParse(order.user_id).success
    || !/^[A-Za-z0-9_-]{1,64}$/.test(input.merchantNamespace)) throw new Error('PAY_WAFFO_CHECKOUT_INVALID');
  const first30 = order.offer_kind === 'gold_first30';
  if (!['standard', 'gold_first30', 'founder', 'founder_renewal'].includes(order.offer_kind)
    || (first30 && (snapshot.billing_cycle !== 'monthly' || snapshotAmountDue(snapshot) !== 4900))
    || (order.offer_kind.startsWith('founder')
      && (snapshot.billing_cycle !== 'yearly' || snapshotAmountDue(snapshot) !== 49600))) {
    throw new Error('PAY_WAFFO_CHECKOUT_INVALID');
  }
  return {
    productId: input.productId, currency: 'USD', withTrial: first30,
    // Opaque, per-merchant account identity; no email/contact data or reusable authentication secret.
    buyerIdentity: createHash('sha256').update(`waffo:test:${input.merchantNamespace}:${order.user_id}`).digest('hex'),
    includePaymentMethods: ['card'], orderMerchantExternalId: order.id,
    metadata: { orderId: order.id }, expiresInSeconds: WAFFO_CHECKOUT_TTL_SECONDS,
    successUrl: `${origin.origin}/profile?tab=subscription&order_id=${encodeURIComponent(order.id)}`,
  };
}

export function validateWaffoCheckoutSession(value: unknown, input: {
  createdAfter: number; latestExpiry: number; allowedCheckoutOrigin: string;
}) {
  const session = sessionSchema.parse(value);
  const url = new URL(session.checkoutUrl);
  const allowed = new URL(input.allowedCheckoutOrigin);
  const expiry = Date.parse(session.expiresAt);
  if (allowed.protocol !== 'https:' || url.origin !== allowed.origin || url.username || url.password
    || !url.pathname.endsWith(`/checkout/${session.sessionId}`)
    || !Number.isFinite(input.createdAfter) || !Number.isFinite(input.latestExpiry)
    || expiry <= input.createdAfter || expiry > input.latestExpiry) throw new Error('PAY_WAFFO_CHECKOUT_CONFLICT');
  return session;
}

/** Persisted dispatch admission is one-shot. Merchant external ID is NOT assumed idempotent.
 * On a timeout/write failure a caller must recover the same intent, never create a second session. */
export async function dispatchWaffoCheckout(input: {
  request: ReturnType<typeof buildWaffoCheckoutRequest>;
  claimDispatch: () => Promise<boolean>;
  create: (request: ReturnType<typeof buildWaffoCheckoutRequest>) => Promise<unknown>;
  recover: () => Promise<unknown | null>;
  persist: (session: z.infer<typeof sessionSchema>) => Promise<void>;
  createdAfter: number; latestExpiry: number; allowedCheckoutOrigin: string;
}) {
  const claimed = await input.claimDispatch();
  const result = claimed ? await input.create(input.request) : await input.recover();
  if (!result) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
  const session = validateWaffoCheckoutSession(result, input);
  await input.persist(session);
  return session;
}
