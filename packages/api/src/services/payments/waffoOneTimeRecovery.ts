/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WaffoOperationsClient } from './waffoTestOperationsClient';
import { readPaymentFacts } from './waffoPayments';
import { deliverWaffoOneTime } from './waffoOneTimeDelivery';

type Provider = Pick<WaffoOperationsClient, 'merchant' | 'mode' | 'storeId' | 'findOneTimeOrders' | 'findOrderPayments' | 'readChargebacks'>;
/** A local expiry never proves no charge. Only a complete, authoritative lookup proving all original
 * provider orders canceled and every payment terminal unpaid can release a bound checkout. No match,
 * incomplete lookup, processing cash, or lost checkout identity stays blocked for manual reconciliation. */
export async function recoverWaffoOneTimeCheckouts(db: Pick<SupabaseClient, 'from' | 'rpc'>, provider: Provider,
  userId?: string, afterFulfillment?: (orderId: string) => Promise<unknown>, deadline = Date.now() + 20_000) {
  let query = db.from('payment_orders').select('id,user_id').eq('payment_channel', 'waffo').eq('mode', 'payment')
    .eq('auto_renew', false).eq('payment_mode', provider.mode).eq('merchant_namespace', provider.merchant)
    .eq('payment_status', 'unpaid').eq('qualification_state', 'reserved').is('purchase_closed_at', null)
    .lt('method_checkout_expires_at', new Date().toISOString()).order('created_at', { ascending: true });
  if (userId) query = query.eq('user_id', userId);
  const due = await query.limit(100);
  if (due.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  let closed = 0;
  const blocked: string[] = [];
  for (const row of (due.data ?? []) as { id: string; user_id: string }[]) {
    if (Date.now() >= deadline) { blocked.push(row.id); continue; }
    try {
      const orders = await provider.findOneTimeOrders(row.id, deadline);
      if (Date.now() >= deadline) { blocked.push(row.id); continue; }
      const payments = await provider.findOrderPayments(row.id, deadline);
      let paidApplied = 0;
      let paidUnresolved = false;
      // Lookups return all original identities, never just the first payment or a caller's chosen channel.
      for (const payment of payments.filter(p => p.status === 'succeeded')) {
        const reading = readPaymentFacts(payment, provider.storeId, provider.mode);
        if (reading.kind !== 'paid' || reading.facts.purchaseMode !== 'payment') { paidUnresolved = true; continue; }
        const delivered = await deliverWaffoOneTime(db, provider, reading.facts, deadline);
        if (delivered.state === 'applied') {
          if (afterFulfillment) await afterFulfillment(row.id);
          paidApplied++;
        } else paidUnresolved = true;
      }
      if (paidApplied === 1 && !paidUnresolved && payments.every(p => ['succeeded', 'failed', 'canceled'].includes(p.status))) continue;
      if (!orders.length || orders.some(o => o.status !== 'canceled')
        || payments.some(p => !['failed', 'canceled'].includes(p.status))) { blocked.push(row.id); continue; }
      const checkout = await db.from('payment_provider_refs').select('external_id').eq('order_id', row.id).eq('channel', 'waffo')
        .eq('merchant_namespace', provider.merchant).eq('mode', provider.mode).eq('object_type', 'checkout').maybeSingle();
      if (checkout.error || !checkout.data) { blocked.push(row.id); continue; }
      const result = await db.rpc('pay_waffo_observe_qualification', { p_order: row.id, p_merchant: provider.merchant,
        p_mode: provider.mode, p_checkout: checkout.data.external_id, p_state: 'closed_unpaid', p_payment: null,
        p_amount: 0, p_currency: 'usd', p_paid_at: null });
      if (result.error) { blocked.push(row.id); continue; }
      closed++;
    } catch { blocked.push(row.id); }
  }
  return { closed, blocked };
}
