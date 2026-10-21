/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from '../stripe';
import { getWaffoOperationsClient, type WaffoOperationsClient } from './waffoTestOperationsClient';
import type { RefundStripe } from './packageRefund';

/** Resolve the original order's provider before constructing any provider client. Current new-sale
 * routing and a Stripe outage cannot reroute an existing Waffo refund. */
export async function dispatchOrderRefund<T>(db: SupabaseClient, orderId: string,
  stripe: (provider: RefundStripe) => Promise<T>, waffo: (provider: WaffoOperationsClient) => Promise<T>) {
  const result = await db.from('payment_orders').select('payment_channel,payment_mode').eq('id', orderId).single();
  if (result.error || !result.data) throw new Error('PAY_REFUND_ORDER_UNKNOWN');
  if (result.data.payment_channel === 'waffo') {
    if (!['test', 'live'].includes(result.data.payment_mode)) throw new Error('PAY_REFUND_SCOPE_UNKNOWN');
    return waffo(getWaffoOperationsClient(result.data.payment_mode));
  }
  if (result.data.payment_channel !== 'stripe') throw new Error('PAY_REFUND_SCOPE_UNKNOWN');
  return stripe(getStripeClient());
}
