/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeScope } from './purchaseFacts';

type Db = Pick<SupabaseClient, 'from'>;
type Ref = { id: string; channel: string; merchant_namespace: string; mode: string; object_type: string;
  external_id: string; order_id: string | null; subscription_id: string | null };
const columns = 'id,channel,merchant_namespace,mode,object_type,external_id,order_id,subscription_id';
export async function findStripeReference(db: Db, objectType: string, externalId: string, scope?: StripeScope) {
  let query = db.from('payment_provider_refs').select(columns).eq('channel', 'stripe')
    .eq('object_type', objectType).eq('external_id', externalId);
  if (scope) query = query.eq('merchant_namespace', scope.merchant).eq('mode', scope.mode);
  const result = await query.limit(2);
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
  if (result.data.length > 1) throw new Error('PAY_COMMON_MAPPING_AMBIGUOUS');
  return result.data[0] as Ref | undefined;
}

// Preserve existing presentation field names, but obtain their values only from provider refs.
// Private financial rows passed here must come from the server client, never request metadata.
export async function resolveStripeOrderIds<T extends { id?: string | null; price_ref_id?: string | null;
  subscription_id?: string | null; payment_channel?: string | null; merchant_namespace?: string | null;
  payment_mode?: string | null }>(db: Db, order: T) {
  if (!order.id || order.payment_channel !== 'stripe' || !order.merchant_namespace || !order.payment_mode) {
    throw new Error('PAY_COMMON_ORDER_IDENTITY_UNKNOWN');
  }
  const result = await db.from('payment_provider_refs').select(columns).eq('order_id', order.id)
    .eq('channel', 'stripe').eq('merchant_namespace', order.merchant_namespace).eq('mode', order.payment_mode);
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
  const one = (kind: string) => {
    const refs = (result.data as Ref[]).filter(ref => ref.object_type === kind);
    if (refs.length > 1) throw new Error('PAY_COMMON_MAPPING_AMBIGUOUS');
    return refs[0]?.external_id ?? null;
  };
  const price = order.price_ref_id ? await db.from('payment_provider_refs').select('external_id')
    .eq('id', order.price_ref_id).eq('object_type', 'price').eq('channel', 'stripe')
    .eq('merchant_namespace', order.merchant_namespace).eq('mode', order.payment_mode).maybeSingle() : null;
  if (price?.error || !price?.data) throw new Error('PAY_COMMON_PRICE_MAPPING_MISSING');
  let subscription: string | null = null;
  if (order.subscription_id) {
    const ref = await db.from('payment_provider_refs').select('external_id')
      .eq('subscription_id', order.subscription_id).eq('object_type', 'subscription').eq('channel', 'stripe')
      .eq('merchant_namespace', order.merchant_namespace).eq('mode', order.payment_mode).limit(2);
    if (ref.error || !Array.isArray(ref.data) || ref.data.length !== 1) throw new Error('PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING');
    subscription = ref.data[0].external_id;
  }
  return { ...order, stripe_price_id: price.data.external_id as string,
    stripe_checkout_session_id: one('checkout'), stripe_invoice_id: one('invoice'), stripe_subscription_id: subscription };
}
