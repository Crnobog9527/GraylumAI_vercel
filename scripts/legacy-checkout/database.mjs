/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { assertLegacyOrder, CUTOFF, verifyLegacyCheckout } from './evidence.mjs';

// Deliberately excludes free-form metadata and all contact information.
export const ORDER_SELECT = `SELECT o.id,o.user_id,o.item_type,o.item_id,o.billing_cycle,
  o.stripe_checkout_session_id,o.stripe_invoice_id,o.stripe_subscription_id,o.stripe_price_id,
  o.stripe_customer_id,o.amount_total,o.currency,o.mode,o.status,o.payment_status,o.fulfilled_at,
  o.created_at,o.payment_channel,o.merchant_namespace,o.payment_mode,o.purchase_action,
  o.purchase_snapshot,o.purchase_request_id,o.payment_amount_facts,o.subscription_id,o.source_order_id,
  o.purchase_closed_at,o.purchase_close_reason,o.purchase_close_ref,
  (EXISTS(SELECT 1 FROM public.payment_provider_refs r WHERE r.order_id=o.id)
    OR EXISTS(SELECT 1 FROM public.payment_orders r WHERE r.source_order_id=o.id)
    OR EXISTS(SELECT 1 FROM public.subscription_credit_grants r WHERE r.source_order_id=o.id)
    OR EXISTS(SELECT 1 FROM public.credit_transactions r WHERE r.source_order_id=o.id)) AS has_related_facts
  FROM public.payment_orders o`;

export async function inventory(db, orderId) {
  await db.query('BEGIN READ ONLY');
  try {
    const result = await db.query(`${ORDER_SELECT} WHERE ${orderId ? 'o.id=$1' : `o.payment_channel IS NULL
      AND o.item_type='membership_plan' AND o.created_at < $1 AND
      (o.status='pending' OR o.purchase_close_reason='stripe_checkout_expired')`}
      ORDER BY o.created_at,o.id LIMIT 1001`, [orderId ?? CUTOFF]);
    if (result.rows.length > 1000) throw new Error('INVENTORY_INCOMPLETE');
    await db.query('COMMIT');
    return result.rows;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function closeOne(db, stripe, order, scope) {
  // Lock the same profile then order as admission/fulfillment before fresh evidence reads.
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query('SELECT id FROM public.profiles WHERE id=$1 FOR UPDATE', [order.user_id]);
    await db.query('SELECT id FROM public.payment_orders WHERE id=$1 FOR UPDATE', [order.id]);
    const current = (await db.query(`${ORDER_SELECT} WHERE o.id=$1`, [order.id])).rows[0];
    if (!current || current.user_id !== order.user_id) throw new Error('LOCAL_FACTS_CHANGED');
    assertLegacyOrder(current);
    await verifyLegacyCheckout(stripe, current, scope);
    const result = await db.query(`SELECT public.pay_common_close_checkout($1,$2,$3,$4,$5,
      'legacy_expired','unpaid') AS closed`, [current.user_id,current.id,current.stripe_checkout_session_id,
      scope.merchant,scope.mode]);
    if (typeof result.rows[0]?.closed !== 'boolean') throw new Error('CLOSE_RESULT_UNKNOWN');
    await db.query('COMMIT');
    return result.rows[0].closed ? 'closed' : 'already_closed';
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

const safeCodes = new Set(['LOCAL_FACTS_UNRESOLVED', 'PROVIDER_SCOPE_MISMATCH', 'PROVIDER_IDENTITY_MISMATCH',
  'PROVIDER_FACTS_UNRESOLVED', 'CUSTOMER_FACTS_UNRESOLVED', 'LOCAL_FACTS_CHANGED', 'CLOSE_RESULT_UNKNOWN']);
export async function processOrder({ db, stripe, order, scope, apply = false }) {
  try {
    const closed = assertLegacyOrder(order);
    if (apply) return { orderId: order.id, outcome: await closeOne(db, stripe, order, scope) };
    await verifyLegacyCheckout(stripe, order, scope);
    return { orderId: order.id, outcome: closed ? 'already_closed' : 'eligible' };
  } catch (error) {
    // Do not expose SDK/DB error messages: these may contain credentials or user data.
    return { orderId: order.id, outcome: 'unresolved', reason: safeCodes.has(error.message)
      ? error.message : apply ? 'CLOSE_OR_EVIDENCE_UNCERTAIN_REINVENTORY_REQUIRED' : 'EVIDENCE_UNAVAILABLE' };
  }
}
