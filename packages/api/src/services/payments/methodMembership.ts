/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPaymentMethodRoutes } from './methodRouting';

/** Read-only member-page projection. Orders remain the authority for paid access; a pending
 * checkout or provider subscription status alone cannot grant membership. Founder capacity is
 * shared across merchants/methods in the same mode, matching 0204's atomic reservation. */
export async function readMethodMembership(db: SupabaseClient, userId: string, now = Date.now()) {
  const [routes, orders, sold, reserved, review] = await Promise.all([
    readPaymentMethodRoutes(db),
    db.from('payment_orders').select([
      'id', 'subscription_id', 'purchase_membership_level', 'payment_method', 'auto_renew',
      'entitlement_start', 'entitlement_end', 'offer_kind', 'billing_cycle',
    ].join(',')).eq('user_id', userId).eq('payment_mode', 'test')
      .eq('item_type', 'membership_plan').eq('qualification_state', 'sold')
      .eq('payment_status', 'paid').eq('status', 'completed').not('fulfilled_at', 'is', null)
      .gt('entitlement_end', new Date(now).toISOString()).order('entitlement_start', { ascending: true }).limit(100),
    db.from('payment_orders').select('id', { count: 'exact', head: true })
      .eq('payment_mode', 'test').eq('offer_kind', 'founder').eq('qualification_state', 'sold'),
    db.from('payment_orders').select('id', { count: 'exact', head: true })
      .eq('payment_mode', 'test').eq('offer_kind', 'founder').eq('qualification_state', 'reserved'),
    db.from('payment_orders').select('id', { count: 'exact', head: true })
      .eq('payment_mode', 'test').eq('offer_kind', 'founder').eq('qualification_state', 'review')
      .is('qualification_closed_ref', null),
  ]);
  if (orders.error || sold.error || reserved.error || review.error || !Array.isArray(orders.data)
    || [sold.count, reserved.count, review.count].some(n => !Number.isSafeInteger(n) || n! < 0)) {
    throw new Error('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  }
  // Historical sold slots never return to the pool, including refunds and cancellation.
  const occupied = sold.count! + reserved.count! + review.count!;
  if (occupied > 50) throw new Error('PAY_WAFFO_FOUNDER_CAPACITY_CONFLICT');
  return { mode: 'test' as const, routes,
    // Still closed at the application boundary until fulfillment and step 3 are complete.
    checkoutReady: false,
    founder: { total: 50, sold: sold.count!, reserved: reserved.count! + review.count!, available: 50 - occupied },
    memberships: orders.data,
  };
}
