/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPaymentMethodRoutes } from './methodRouting';

// Keep public purchase admission closed until the complete delivery/recovery path is accepted.
export const METHOD_CHECKOUT_READY = false;

/** Read-only member-page projection. Orders remain the authority for paid access; a pending
 * checkout or provider subscription status alone cannot grant membership. Founder capacity is
 * shared across merchants/methods in the same mode, matching 0204's atomic reservation. */
export async function readMethodMembership(db: SupabaseClient, userId: string, now = Date.now()) {
  const [routes, orders, founderOrders] = await Promise.all([
    readPaymentMethodRoutes(db),
    db.from('payment_orders').select([
      'id', 'subscription_id', 'purchase_membership_level', 'payment_method', 'auto_renew',
      'entitlement_start', 'entitlement_end', 'offer_kind', 'billing_cycle',
    ].join(',')).eq('user_id', userId).eq('payment_mode', 'test')
      .eq('item_type', 'membership_plan').eq('qualification_state', 'sold')
      .eq('payment_status', 'paid').eq('status', 'completed').not('fulfilled_at', 'is', null)
      .gt('entitlement_end', new Date(now).toISOString()).order('entitlement_start', { ascending: true }).limit(100),
    // One statement/snapshot: separately reading sold and reserved can double-count a
    // reservation that becomes sold between reads, or temporarily understate occupied slots.
    db.from('payment_orders').select('qualification_state')
      .eq('payment_mode', 'test').eq('offer_kind', 'founder')
      .or('qualification_state.in.(sold,reserved),and(qualification_state.eq.review,qualification_closed_ref.is.null)')
      .limit(51),
  ]);
  if (orders.error || founderOrders.error || !Array.isArray(orders.data) || !Array.isArray(founderOrders.data)
    || founderOrders.data.some(row => !['sold', 'reserved', 'review'].includes(row.qualification_state))) {
    throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  }
  // Historical sold slots never return to the pool, including refunds and cancellation.
  const occupied = founderOrders.data.length;
  const sold = founderOrders.data.filter(row => row.qualification_state === 'sold').length;
  if (occupied > 50) throw new Error('PAY_WAFFO_FOUNDER_CAPACITY_CONFLICT');
  return { mode: 'test' as const, routes,
    // Still closed at the application boundary until fulfillment and step 3 are complete.
    checkoutReady: METHOD_CHECKOUT_READY,
    founder: { total: 50, sold, reserved: occupied - sold, available: 50 - occupied },
    memberships: orders.data,
  };
}
