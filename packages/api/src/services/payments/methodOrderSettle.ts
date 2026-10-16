/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeScope } from './purchaseFacts';
import { CHECKOUT_ABSENCE_GRACE_SECONDS, findCheckoutForOrder } from './stripeCheckoutIntent';
import { recoverMethodCheckout } from './walletWebhook';

const DAY = 86400;
// Admission and claim run in one request, seconds apart: an older never-claimed order was stranded by a failure in
// between (e.g. a missing price mapping). A release racing a live claim is refused by the database either way.
export const UNCLAIMED_GRACE_SECONDS = 600;
const COLUMNS = 'id,user_id,created_at,method_dispatched_at,method_checkout_expires_at';

type OpenOrder = { id: string; user_id: string; created_at: string; method_dispatched_at: string | null;
  method_checkout_expires_at: string | null };
export type SettleOutcome = 'closed' | 'paid' | 'open' | 'waiting';
export type OpenOrderFinding = { kind: 'open_order_unresolved' | 'scan_incomplete' | 'scan_failed'; object: 'order';
  orderId?: string; code?: string };

const seconds = (value: string | null) => value === null ? null : Math.floor(Date.parse(value) / 1000);

/** Unpaid new-method Stripe orders still open: what pay_waffo_admit_purchase (0222) counts as a payment in progress. */
function openMethodOrders(db: SupabaseClient, scope: StripeScope) {
  return db.from('payment_orders').select(COLUMNS).eq('payment_channel', 'stripe').eq('merchant_namespace', scope.merchant)
    .eq('payment_mode', scope.mode).in('payment_method', ['wechat_pay', 'alipay', 'card', 'card_cn'])
    .eq('payment_status', 'unpaid').is('fulfilled_at', null).is('purchase_closed_at', null);
}

async function close(db: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const closed = await db.rpc(fn, args);
  if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE', { cause: closed.error });
}

/** #961: an order that can no longer be paid would block the buyer's other purchases (PAY_WAFFO_PURCHASE_PENDING)
 * when its session expired without the webhook, or it failed after admission and before its claim. Stripe is
 * read first, every time; then the order is closed through the function its own path uses (session expired:
 * the webhook's recovery; claimed but never created: pay_waffo_close_uncreated; never claimed:
 * pay_waffo_abort_before_dispatch). A paid session is delivered by the same recovery, never closed. Local time
 * only delays a close (grace periods), it never decides one: each close function re-checks the order itself. */
export async function settleMethodOrder(db: SupabaseClient, stripe: Stripe, scope: StripeScope, order: OpenOrder,
  now = Math.floor(Date.now() / 1000)): Promise<SettleOutcome> {
  const ref = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id)
    .eq('object_type', 'checkout').eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode)
    .maybeSingle();
  if (ref.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE', { cause: ref.error });
  let sessionId: string | null = ref.data?.external_id ?? null;
  const owner = { p_user: order.user_id, p_order: order.id, p_merchant: scope.merchant };
  if (!sessionId && !order.method_dispatched_at) {
    const created = seconds(order.created_at)!;
    if (now < created + UNCLAIMED_GRACE_SECONDS) return 'waiting';
    // Nothing goes to Stripe before the claim; a session for this order anyway is left for manual review.
    if (await findCheckoutForOrder(stripe, order.id, created - 300, Math.min(now, created + DAY))) {
      throw new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
    }
    await close(db, 'pay_waffo_abort_before_dispatch', { ...owner, p_expected: null });
    return 'closed';
  }
  if (!sessionId) {
    const expires = seconds(order.method_checkout_expires_at);
    if (expires === null) throw new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
    sessionId = (await findCheckoutForOrder(stripe, order.id, expires - DAY, expires))?.id ?? null;
    if (!sessionId) {
      if (now < expires + CHECKOUT_ABSENCE_GRACE_SECONDS) return 'waiting';
      await close(db, 'pay_waffo_close_uncreated', owner);
      return 'closed';
    }
  }
  // Retrieves the session at Stripe, binds it if unmapped, closes it expired-unpaid or delivers it paid.
  const seen = await recoverMethodCheckout(db, stripe, sessionId);
  if (seen?.paymentStatus === 'paid') return 'paid';
  return seen?.checkoutStatus === 'expired' && seen.paymentStatus === 'unpaid' ? 'closed' : 'open';
}

/** The buyer's own open orders, settled when admission refuses another plan. True if any was closed or delivered,
 * so admission is worth running again; a failure keeps the order (and the buyer's pending answer) as it was. */
export async function settleBuyerOrders(db: SupabaseClient, stripe: Stripe, scope: StripeScope, userId: string,
  now = Math.floor(Date.now() / 1000)) {
  const rows = await openMethodOrders(db, scope).eq('user_id', userId).order('created_at').limit(5);
  if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE', { cause: rows.error });
  let settled = false;
  for (const order of rows.data as OpenOrder[]) {
    const outcome = await settleMethodOrder(db, stripe, scope, order, now).catch(() => 'open' as const);
    if (outcome === 'closed' || outcome === 'paid') settled = true;
  }
  return settled;
}

/** Daily backstop (billing-reconcile): every open order older than the claim grace, in id order a page at a time. */
export async function settleOpenMethodOrders(db: SupabaseClient, stripe: Stripe, scope: StripeScope,
  options: { now: number; deadline: number; maxPages: number; pageSize?: number }) {
  const findings: OpenOrderFinding[] = [];
  const pageSize = options.pageSize ?? 100;
  let checked = 0, repaired = 0, after = '';
  for (let page = 0; page < options.maxPages; page++) {
    let query = openMethodOrders(db, scope).lt('created_at', new Date((options.now - UNCLAIMED_GRACE_SECONDS) * 1000).toISOString());
    if (after) query = query.gt('id', after);
    const rows = await query.order('id').limit(pageSize);
    if (rows.error || !Array.isArray(rows.data)) {
      findings.push({ kind: 'scan_failed', object: 'order', code: 'PAY_WAFFO_PERSISTENCE_UNAVAILABLE' });
      return { checked, repaired, complete: false, findings };
    }
    for (const order of rows.data as OpenOrder[]) {
      if (Date.now() > options.deadline) {
        findings.push({ kind: 'scan_incomplete', object: 'order', code: 'TIME_BUDGET' });
        return { checked, repaired, complete: false, findings };
      }
      checked++;
      try {
        const outcome = await settleMethodOrder(db, stripe, scope, order, options.now);
        if (outcome === 'closed' || outcome === 'paid') repaired++;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        findings.push({ kind: 'open_order_unresolved', object: 'order', orderId: order.id,
          code: /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'UNEXPECTED' });
      }
    }
    if (rows.data.length < pageSize) return { checked, repaired, complete: true, findings };
    after = (rows.data[rows.data.length - 1] as OpenOrder).id;
  }
  findings.push({ kind: 'scan_incomplete', object: 'order', code: 'OPEN_ORDERS_OVER_LIMIT' });
  return { checked, repaired, complete: false, findings };
}
