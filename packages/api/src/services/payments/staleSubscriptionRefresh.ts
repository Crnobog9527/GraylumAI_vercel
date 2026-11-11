/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleCardSubscriptionState } from './cardSubscriptionWebhook';
import { syncSubscriptionState } from '../stripeFulfillment';
import type { StripeScope } from './purchaseFacts';
import { errorCode, logSwallowed } from '../../lib/swallow';

/** PAY-STALE-SUB (2026-11-08): a Stripe subscription whose final event was lost, or never handled (legacy D17
 * subscriptions after ARCH-FIX F2), stays in a renewing status after its period has ended. Membership facts then grant
 * nothing, but purchase admission (0211) still reads the row as a live membership and refuses every new purchase.
 *
 * This reads the subscription's current state at Stripe (read only) and applies it through the same idempotent sync the
 * webhook uses: PAY-STRIPE-MP card subscriptions through `handleCardSubscriptionState`, legacy subscriptions through
 * `syncSubscriptionState` (pay_common_sync_subscription). Neither can end another subscription: MP settles the level
 * from paid terms, and the legacy sync lowers the profile only when no other subscription of the buyer is live. A
 * subscription Stripe still renews (retries on days 1, 3 and 5) stays as it is, so it keeps blocking a second charge. */

/** The statuses admission (0211) reads as a live subscription. */
const RENEWING = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];
/** The card renewal grace of pay_common_membership_facts: until then a late renewal webhook is still expected. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;

export type StaleSubscription = { id: string; user_id: string; status: string; cancel_at_period_end: unknown;
  stripe_subscription_id: string | null };
export type StaleSubscriptionFinding = { kind: 'repair_failed' | 'scan_failed' | 'scan_incomplete'; object: 'subscription';
  externalId?: string; code: string };

/** Renewing local Stripe subscriptions past the grace. A PAY-STRIPE-MP row already stopped at period end is left out:
 * admission no longer counts it once the period ends (0211), and wallet memberships (no Stripe subscription) are all
 * such rows. Legacy rows are included whatever their stop flag, since none of their events is handled any more. */
function staleQuery(db: SupabaseClient, scope: StripeScope, now: number) {
  return db.from('user_subscriptions').select('id,user_id,status,cancel_at_period_end,stripe_subscription_id')
    .eq('payment_channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('payment_mode', scope.mode)
    .in('status', RENEWING).lt('current_period_end', new Date(now - STALE_AFTER_MS).toISOString())
    .or('stripe_subscription_id.not.is.null,cancel_at_period_end.eq.false');
}

/** The Stripe subscription id from our own mapping, never from the row alone. */
async function mappedStripeId(db: SupabaseClient, scope: StripeScope, row: StaleSubscription) {
  const ref = await db.from('payment_provider_refs').select('external_id').eq('subscription_id', row.id)
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode)
    .eq('object_type', 'subscription').limit(2);
  if (ref.error || !Array.isArray(ref.data)) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const externalId = ref.data.length === 1 ? (ref.data[0] as { external_id?: unknown }).external_id : null;
  if (typeof externalId !== 'string' || !externalId.startsWith('sub_')
    || (row.stripe_subscription_id && row.stripe_subscription_id !== externalId)) {
    throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
  }
  return externalId;
}

/** Re-reads one stale subscription at Stripe and applies it. True when the local status or stop flag changed. */
export async function refreshStaleSubscription(db: SupabaseClient, stripe: Stripe, scope: StripeScope, row: StaleSubscription) {
  const subscriptionId = await mappedStripeId(db, scope, row);
  if (row.stripe_subscription_id) await syncSubscriptionState(db, { id: subscriptionId } as Stripe.Subscription);
  else if (!await handleCardSubscriptionState(db, stripe, subscriptionId)) throw new Error('PAY_STALE_SUB_UNCLAIMED');
  const after = await db.from('user_subscriptions').select('status,cancel_at_period_end').eq('id', row.id).maybeSingle();
  if (after.error || !after.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const now = after.data as { status: unknown; cancel_at_period_end: unknown };
  return now.status !== row.status || String(now.cancel_at_period_end) !== String(row.cancel_at_period_end);
}

/** Purchase path: called only after admission refused a buyer as an existing member. Best effort: a Stripe or
 * database failure keeps the refusal (logged), never opens a purchase. True when any subscription changed. */
export async function refreshBuyerStaleSubscriptions(db: SupabaseClient, stripe: Stripe, scope: StripeScope, userId: string,
  now = Date.now()) {
  const rows = await staleQuery(db, scope, now).eq('user_id', userId).order('id').limit(20);
  if (rows.error || !Array.isArray(rows.data)) {
    logSwallowed('stale_subscription_buyer_read_failed', rows.error, { category: 'billing' });
    return false;
  }
  let changed = false;
  for (const row of rows.data as StaleSubscription[]) {
    try { changed = await refreshStaleSubscription(db, stripe, scope, row) || changed; } catch (error) {
      logSwallowed('stale_subscription_buyer_refresh_failed', error, { category: 'billing', subscriptionId: row.id });
    }
  }
  return changed;
}

/** Daily backstop (billing-reconcile): every stale subscription of this Stripe account, in id order a page at a time
 * past the last row seen (a repaired row leaves the list, so offsets would skip rows). One that cannot be applied stays
 * a finding (alerted) and is tried again the next day. */
export async function reconcileStaleSubscriptions(db: SupabaseClient, stripe: Stripe, scope: StripeScope,
  options: { deadline: number; maxPages: number; now?: number }) {
  const findings: StaleSubscriptionFinding[] = [];
  let checked = 0, repaired = 0, complete = true, after = '';
  for (let page = 0; page < options.maxPages; page++) {
    let query = staleQuery(db, scope, options.now ?? Date.now());
    if (after) query = query.gt('id', after);
    const rows = await query.order('id').limit(PAGE);
    if (rows.error || !Array.isArray(rows.data)) {
      findings.push({ kind: 'scan_failed', object: 'subscription', code: 'PAY_WAFFO_PERSISTENCE_UNAVAILABLE' });
      return { checked, repaired, complete: false, findings };
    }
    const data = rows.data as StaleSubscription[];
    for (const row of data) {
      if (Date.now() > options.deadline) {
        findings.push({ kind: 'scan_incomplete', object: 'subscription', code: 'TIME_BUDGET' });
        return { checked, repaired, complete: false, findings };
      }
      checked++;
      try {
        if (await refreshStaleSubscription(db, stripe, scope, row)) repaired++;
      } catch (error) {
        findings.push({ kind: 'repair_failed', object: 'subscription', externalId: row.id, code: errorCode(error) });
      }
    }
    if (data.length < PAGE) return { checked, repaired, complete, findings };
    after = data[data.length - 1]!.id;
  }
  complete = false;
  findings.push({ kind: 'scan_incomplete', object: 'subscription', code: 'STALE_SUBSCRIPTIONS_OVER_LIMIT' });
  return { checked, repaired, complete, findings };
}
