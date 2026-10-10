/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type Db = Pick<SupabaseClient, 'rpc'>;
/** Server-created adapter only. No production mode, arbitrary URLs or customer-selected IDs. */
export type WaffoTestOperations = {
  merchant: string; mode: 'test';
  cancelSubscription: (orderId: string) => Promise<{ orderId: string; status: string }>;
  readSubscription: (orderId: string) => Promise<{ orderId: string; status: string }>;
  setProductStatus: (productId: string, status: 'inactive' | 'active') => Promise<{ id: string; status: string }>;
  readProduct: (productId: string) => Promise<{ id: string; status: string }>;
};
const cancelIntent = z.object({ dispatch: z.boolean(), dispatchedAt: z.string().optional(), subscriptionId: z.uuid(), providerId: z.string(),
  merchant: z.string(), mode: z.literal('test') });
const controlIntent = z.object({ operationId: z.uuid(), productId: z.string(), merchant: z.string(), mode: z.literal('test'),
  state: z.enum(['blocking', 'blocked', 'restoring', 'active']), version: z.number() });
function scope(provider: WaffoTestOperations, merchant: string) {
  if (provider.mode !== 'test' || provider.merchant !== merchant) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
}
export async function cancelWaffoMembership(db: Db, provider: WaffoTestOperations, userId: string, subscriptionId: string) {
  const result = await db.rpc('pay_waffo_cancel_intent', { p_user: userId, p_subscription: subscriptionId });
  if (result.error) throw new Error('PAY_WAFFO_CANCEL_UNAVAILABLE');
  const intent = cancelIntent.parse(result.data);
  scope(provider, intent.merchant);
  // A timeout leaves the intent intact. Recover the original subscription before any conditional retry.
  let observed = await (intent.dispatch ? provider.cancelSubscription(intent.providerId) : provider.readSubscription(intent.providerId));
  if (observed.orderId !== intent.providerId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  if (!intent.dispatch && observed.status === 'active' && intent.dispatchedAt) {
    const retry = await db.rpc('pay_waffo_retry_cancel', { p_user: userId, p_subscription: intent.subscriptionId,
      p_merchant: intent.merchant, p_provider: intent.providerId, p_expected: intent.dispatchedAt });
    if (retry.error) throw new Error('PAY_WAFFO_CANCEL_UNAVAILABLE');
    if (retry.data === true) observed = await provider.cancelSubscription(intent.providerId);
    if (observed.orderId !== intent.providerId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  }
  if (!['canceling', 'canceled'].includes(observed.status)) return { state: 'pending' as const };
  const saved = await db.rpc('pay_waffo_cancel_result', { p_subscription: intent.subscriptionId,
    p_merchant: intent.merchant, p_provider: observed.orderId, p_state: observed.status });
  if (saved.error) throw new Error('PAY_WAFFO_CANCEL_UNAVAILABLE');
  return { state: 'confirmed' as const };
}

export async function controlWaffoProduct(db: Db, provider: WaffoTestOperations, input: {
  actorId: string; priceRefId: string; blocked: boolean; expectedVersion: number;
}) {
  const result = await db.rpc('pay_waffo_product_control', {
    p_actor: input.actorId, p_ref: input.priceRefId, p_block: input.blocked, p_expected: input.expectedVersion,
  });
  if (result.error) throw new Error('PAY_WAFFO_CONTROL_UNAVAILABLE');
  if (result.data?.state === 'active' && result.data?.version === 0) return { state: 'active' };
  const intent = controlIntent.parse(result.data);
  scope(provider, intent.merchant);
  if (intent.state === 'active' || intent.state === 'blocked') return { state: intent.state };
  // Query before every attempt; status assignment is idempotent and does not cancel subscribers.
  // A write timeout is propagated without retry. Recovery always begins with this authoritative read.
  const target = intent.state === 'blocking' ? 'inactive' : 'active';
  let observed = await provider.readProduct(intent.productId);
  if (observed.id !== intent.productId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  if (observed.status !== target) observed = await provider.setProductStatus(intent.productId, target);
  if (observed.id !== intent.productId || observed.status !== target) throw new Error('PAY_WAFFO_CONTROL_PENDING');
  const saved = await db.rpc('pay_waffo_product_control_result', {
    p_ref: input.priceRefId, p_operation: intent.operationId, p_status: target,
  });
  if (saved.error) throw new Error('PAY_WAFFO_CONTROL_UNAVAILABLE');
  return { state: saved.data.state as string };
}
