/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { walletMembershipTerm } from './methodMembershipTerm';
import { chargebackCash } from './waffoChargebacks';
import type { WaffoChargeback } from './waffoTestOperationsClient';
import type { PaymentFacts } from './waffoPayments';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;
type Scope = { merchant: string; mode: 'test' | 'live'; readChargebacks?: (paymentId: string, deadline?: number) => Promise<WaffoChargeback[]> };

/** Cash authority is the provider lookup. Prices and periods are taken from the admitted order;
 * the SQL transaction rechecks qualifications, source terms, duplicates and late payments. */
export async function deliverWaffoOneTime(db: Db, provider: Scope, facts: PaymentFacts, deadline?: number) {
  if (!facts.externalId || !z.uuid().safeParse(facts.externalId).success) return { state: 'review' as const, reason: 'offsite_one_time' };
  const found = await db.from('payment_orders').select('*').eq('id', facts.externalId).eq('payment_channel', 'waffo')
    .eq('merchant_namespace', provider.merchant).eq('payment_mode', provider.mode).maybeSingle();
  if (found.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const order = found.data;
  if (!order) return { state: 'review' as const, reason: 'offsite_one_time' };
  const checkout = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id)
    .eq('object_type', 'checkout').eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', provider.mode).maybeSingle();
  if (checkout.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (!checkout.data) throw new Error('PAY_WAFFO_CHECKOUT_NOT_VISIBLE');
  const price = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id)
    .eq('object_type', 'price').eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', provider.mode).maybeSingle();
  if (price.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (!provider.readChargebacks) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  const chargebacks = await provider.readChargebacks(facts.paymentId, deadline);
  let review = facts.productId && facts.productId === price.data?.external_id ? null : 'product_scope';
  let term: { start: string; end: string } | null = null;
  if (!review && facts.method !== 'unknown' && order.item_type === 'membership_plan') {
    let founderRenewal: { originalEnd: string; eligibleUntil: string } | undefined;
    let walletRenewal: { originalEnd: string } | undefined;
    if (['wallet_renewal', 'founder_renewal'].includes(order.method_transition)) {
      const prior = await db.from('payment_orders').select('entitlement_end').eq('id', order.source_order_id)
        .eq('user_id', order.user_id).maybeSingle();
      if (prior.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      if (!prior.data?.entitlement_end) review = 'source_term_unknown';
      else if (order.method_transition === 'wallet_renewal') walletRenewal = { originalEnd: prior.data.entitlement_end };
      else {
        const deadline = await db.rpc('pay_waffo_founder_deadline', { p_order: order.source_order_id });
        if (deadline.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
        if (typeof deadline.data !== 'string') review = 'founder_term_unknown';
        else founderRenewal = { originalEnd: prior.data.entitlement_end, eligibleUntil: deadline.data };
      }
    }
    if (!review) {
      try { term = walletMembershipTerm({ paidAt: facts.createdAt, term: order.entitlement_term, founderRenewal, walletRenewal }); }
      catch { review = 'term_invalid'; }
    }
  }
  const result = await db.rpc('pay_failover_fulfill', { p_order: order.id, p_merchant: provider.merchant,
    p_checkout: checkout.data.external_id, p_payment: facts.paymentId, p_method: facts.method,
    p_review: chargebacks.length ? 'chargeback_observed' : review,
    p_amount: facts.amountCents, p_currency: facts.currency, p_paid_at: facts.createdAt,
    p_start: term?.start ?? null, p_end: term?.end ?? null });
  if (result.error) {
    const reason = /\b(PAY_(?:WAFFO|FAILOVER)_[A-Z_]{1,50})\b/.exec(result.error.message ?? '')?.[1];
    if (!reason) throw new Error('PAY_WAFFO_DELIVERY_UNAVAILABLE');
    return { state: 'review' as const, reason: reason.toLowerCase() };
  }
  let disputeNeedsReview = false;
  for (const dispute of chargebacks) {
    const cash = chargebackCash(dispute, facts.currency, facts.amountCents);
    disputeNeedsReview ||= cash.unknown;
    const frozen = await db.rpc('pay_failover_dispute_observed', { p_order: order.id, p_merchant: provider.merchant,
      p_mode: provider.mode, p_payment: facts.paymentId, p_dispute: dispute.id, p_amount: cash.amount,
      p_currency: cash.currency, p_observed_at: dispute.createdAt });
    if (frozen.error) throw new Error('PAY_WAFFO_DISPUTE_UNAVAILABLE');
  }
  if (chargebacks.length) return { state: 'review' as const,
    reason: disputeNeedsReview ? 'chargeback_amount_unknown' : 'chargeback_observed' };
  if (result.data?.state === 'fulfilled') return { state: 'applied' as const, reason: 'delivered' };
  return { state: 'review' as const, reason: review ?? 'payment_in_review' };
}
