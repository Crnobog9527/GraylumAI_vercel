/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type StripeScope, type PurchaseAction } from './purchaseFacts';
import { buildStripeCheckoutRequest, dispatchStripeCheckoutIntent } from './stripeCheckoutIntent';
import { closeExpiredStripeCheckout, type CheckoutEvidenceOrder } from './stripePurchaseEvidence';

type PaymentDb = Pick<SupabaseClient, 'from' | 'rpc'>;
type PurchaseOrder = CheckoutEvidenceOrder & {
  price_ref_id: string;
  checkout_request: Stripe.Checkout.SessionCreateParams | null;
  metadata: { productName?: string };
  created_at: string;
};

const stripeScopes = new WeakMap<object, Promise<StripeScope>>();
export async function resolveStripeScope(stripe: Pick<Stripe, 'accounts' | 'balance'>): Promise<StripeScope> {
  const cached = stripeScopes.get(stripe);
  if (cached) return cached;
  const pending = Promise.all([stripe.accounts.retrieveCurrent(), stripe.balance.retrieve()]).then(([merchant, balance]) => {
    // Scope belongs to the authenticated connection, not caller metadata or channel settings.
    if (!/^acct_[A-Za-z0-9]+$/.test(merchant.id) || typeof balance.livemode !== 'boolean') {
      throw new Error('PAY_COMMON_PROVIDER_SCOPE_UNKNOWN');
    }
    return Object.freeze({ merchant: merchant.id, mode: balance.livemode ? 'live' as const : 'test' as const });
  });
  stripeScopes.set(stripe, pending);
  try { return await pending; } catch (error) { stripeScopes.delete(stripe); throw error; }
}

function objectId(value: string | { id: string } | null | undefined) {
  return typeof value === 'string' ? value : value?.id ?? null;
}

export async function recordStripeCheckout(
  db: PaymentDb, orderId: string, scope: StripeScope, session: Stripe.Checkout.Session, eventType?: string,
) {
  const result = await db.rpc('pay_common_record_checkout', {
    p_order_id: orderId, p_merchant_namespace: scope.merchant, p_payment_mode: scope.mode,
    p_session: {
      event_type: eventType && /^[a-z_.]{1,80}$/.test(eventType) ? eventType : 'checkout.session.sync',
      id: session.id, object: session.object, livemode: session.livemode, mode: session.mode,
      client_reference_id: session.client_reference_id, metadata: {
        orderId: session.metadata?.orderId, userId: session.metadata?.userId,
        itemId: session.metadata?.itemId, itemType: session.metadata?.itemType,
        billingCycle: session.metadata?.billingCycle, priceId: session.metadata?.priceId,
      },
      amount_total: session.amount_total, currency: session.currency, payment_status: session.payment_status,
      status: session.status, customer: objectId(session.customer), payment_intent: objectId(session.payment_intent),
      invoice: objectId(session.invoice), subscription: objectId(session.subscription),
    },
  });
  if (result.error) throw new Error('PAY_COMMON_CHECKOUT_WRITE_FAILED', { cause: result.error });
  if (result.data?.ok !== true) throw new Error(result.data?.reason ?? 'PAY_COMMON_CHECKOUT_WRITE_FAILED');
}

async function loadMappedSession(db: PaymentDb, order: PurchaseOrder) {
  const result = await db.from('payment_provider_refs').select('external_id, channel, merchant_namespace, mode')
    .eq('order_id', order.id).eq('object_type', 'checkout').limit(2);
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
  if (result.data.length > 1) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  const ref = result.data[0];
  if (ref && (ref.channel !== order.payment_channel || ref.merchant_namespace !== order.merchant_namespace
    || ref.mode !== order.payment_mode)) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  return ref?.external_id as string | undefined;
}

export async function createDurableStripeCheckout(input: {
  db: PaymentDb;
  stripe: Stripe;
  scope: StripeScope;
  userId: string;
  expectedLevel: string;
  action: PurchaseAction;
  appUrl: string;
}) {
  const { db, stripe, scope, action } = input;
  // At most one verified retirement per explicit user request. Unknown outcomes never loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    const admitted = await db.rpc('pay_common_create_purchase', {
      p_user_id: input.userId, p_item_type: action.itemType, p_item_id: action.itemId,
      p_billing_cycle: action.billingCycle, p_merchant_namespace: scope.merchant,
      p_payment_mode: scope.mode, p_expected_level: input.expectedLevel,
    });
    if (admitted.error) {
      const message = typeof admitted.error.message === 'string' ? admitted.error.message : '';
      const pattern = /^(PAY_COMMON_[A-Z_]+|REFUNDED_ORDER_REQUIRES_POLICY|ENTITLEMENT_CONFLICT|ACTIVE_SUBSCRIPTION_EXISTS|UPGRADE_DOWNGRADE_UNSUPPORTED)$/;
      const reason = pattern.test(message)
        ? message : 'PAY_COMMON_PURCHASE_ADMISSION_FAILED';
      throw new Error(reason, { cause: admitted.error });
    }
    const order = (Array.isArray(admitted.data) ? admitted.data[0] : admitted.data) as PurchaseOrder | null;
    if (!order?.id || order.user_id !== input.userId || order.payment_channel !== 'stripe'
      || order.merchant_namespace !== scope.merchant || order.payment_mode !== scope.mode) {
      throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
    }
    const mapping = await db.from('payment_provider_refs').select('external_id, channel, merchant_namespace, mode')
      .eq('id', order.price_ref_id).eq('object_type', 'price').maybeSingle();
    if (mapping.error) throw new Error('PAY_COMMON_MAPPING_READ_FAILED', { cause: mapping.error });
    const price = mapping.data;
    if (!price) throw new Error('PAY_COMMON_PRICE_MAPPING_MISSING');
    if (price.channel !== 'stripe' || price.merchant_namespace !== scope.merchant || price.mode !== scope.mode) {
      throw new Error('PAY_COMMON_PRICE_MAPPING_MISMATCH');
    }
    let request = order.checkout_request;
    if (!request) {
      const prepared = await db.rpc('pay_common_prepare_checkout', {
        p_user_id: input.userId, p_order_id: order.id,
        p_request: buildStripeCheckoutRequest({ orderId: order.id, userId: input.userId,
          snapshot: order.purchase_snapshot, priceId: price.external_id,
          productName: order.metadata.productName ?? 'Credits', appUrl: input.appUrl,
          expiresAt: Math.floor(Date.now() / 1000) + 23 * 3600 }),
      });
      if (prepared.error || !prepared.data) throw new Error('PAY_COMMON_CHECKOUT_PREPARE_FAILED', { cause: prepared.error });
      request = prepared.data as Stripe.Checkout.SessionCreateParams;
    }
    const sessionId = await loadMappedSession(db, order);
    const session = await dispatchStripeCheckoutIntent({ stripe, scope,
      intent: { id: order.id, userId: order.user_id, scope, snapshot: order.purchase_snapshot,
        priceId: price.external_id, request, sessionId: sessionId ?? null, recover: Boolean(order.checkout_request) },
      persistSession: session => recordStripeCheckout(db, order.id, scope, session),
    });
    if (session.status === 'expired') {
      await closeExpiredStripeCheckout({ stripe, supabase: db, scope, order, mappedSessionId: session.id });
      continue;
    }
    return session;
  }
  throw new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
}
