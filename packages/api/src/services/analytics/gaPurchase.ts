/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { centsToMajor } from '../payments/purchaseFacts';

/**
 * Server-side GA4 `purchase` (ANALYTICS plan §3.1, O3, O10 = B; migration 0286). The browser's GA ids are kept
 * per unpaid order only after Termly statistics consent; the fulfilment branch that actually delivers an order
 * takes them out (at most once) and reports one Measurement Protocol event. No order ID, user ID or email is
 * sent: the transaction ID is a fresh random value that is never stored. Statistics only: every failure is
 * logged and swallowed, and nothing is retried; amounts are authoritative in the database.
 */
const CLIENT_ID = /^[0-9]{1,20}\.[0-9]{1,20}$/;
const SESSION_ID = /^[0-9]{1,20}$/;
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,16}$/;
const MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const TIMEOUT_MS = 3000;

export type GaCheckoutIds = { clientId: string; sessionId: string };

/** Browser-supplied ids in GA's own format, or null (forged, oversized or missing values are dropped whole). */
export function parseGaCheckoutIds(value: unknown): GaCheckoutIds | null {
  if (!value || typeof value !== 'object') return null;
  const { clientId, sessionId } = value as Record<string, unknown>;
  if (typeof clientId !== 'string' || typeof sessionId !== 'string') return null;
  return CLIENT_ID.test(clientId) && SESSION_ID.test(sessionId) ? { clientId, sessionId } : null;
}

type GaConfig = { measurementId: string; apiSecret: string };

export function gaServerConfig(env: Record<string, string | undefined> = process.env): GaConfig | null {
  const measurementId = env.NEXT_PUBLIC_GA4_MEASUREMENT_ID?.trim() ?? '';
  const apiSecret = env.GA4_API_SECRET?.trim() ?? '';
  return MEASUREMENT_ID.test(measurementId) && apiSecret.length >= 8 ? { measurementId, apiSecret } : null;
}

/** The moment the ids' consent counts from: the browser's capture time when it is plausible and earlier than the
 * server's own request stamp, else that stamp. A capture time later than the stamp (beyond a few seconds of
 * latency) means the browser clock is ahead and the real capture time is unknown: null, and nothing is stored. */
export function effectiveRequestTime(raw: unknown, requestedAt: Date): Date | null {
  const captured = raw && typeof raw === 'object' ? Date.parse(String((raw as Record<string, unknown>).capturedAt ?? '')) : NaN;
  if (!Number.isFinite(captured)) return requestedAt;
  if (captured > requestedAt.getTime() + 5_000) return null;
  return requestedAt.getTime() - captured <= 10 * 60_000 && captured < requestedAt.getTime() ? new Date(captured) : requestedAt;
}

/** Checkout: keep the ids for this buyer's own unpaid order. `requestedAt` is the server's stamp from before the
 * provider was called: ids from a request that began before the latest consent withdrawal are refused.
 * Never fails the checkout. */
export async function storeGaCheckoutIds(db: SupabaseClient, userId: string, orderId: string, raw: unknown,
  requestedAt: Date) {
  const ids = parseGaCheckoutIds(raw);
  const effective = effectiveRequestTime(raw, requestedAt);
  if (!ids || !effective) return false;
  try {
    const stored = await db.rpc('analytics_store_checkout_ids', { p_user: userId, p_order: orderId,
      p_client: ids.clientId, p_session: ids.sessionId, p_requested_at: effective.toISOString() });
    if (stored.error) throw stored.error;
    return stored.data === true;
  } catch (error) {
    logger.warn('system', 'analytics_checkout_ids_store_failed', { reason: error instanceof Error ? error.name : 'unknown' });
    return false;
  }
}

export type PurchaseOrder = {
  id: string; item_id: string; item_type: string; billing_cycle: string; amount_total: number;
  offer_kind?: string | null; method_transition?: string | null;
};

export function purchaseEvent(order: PurchaseOrder, ids: GaCheckoutIds, transactionId: string) {
  return {
    client_id: ids.clientId,
    non_personalized_ads: true,
    events: [{
      name: 'purchase',
      params: {
        transaction_id: transactionId,
        currency: 'USD',
        // amount_total is the pre-tax price the order was admitted with (tax is charged on top at Stripe).
        value: Number(centsToMajor(order.amount_total)),
        items: [{ item_id: order.item_id }],
        session_id: ids.sessionId,
        engagement_time_msec: 1,
      },
    }],
  };
}

type ReportDeps = { fetch?: typeof fetch; env?: Record<string, string | undefined>; newId?: () => string };

/**
 * Called once from the branch where this call newly fulfilled the order. The ids are always taken (cleared);
 * a founder renewal is not a new purchase (O2), and nothing is sent without configuration or consent ids.
 */
export async function reportGaPurchase(db: SupabaseClient, order: PurchaseOrder, deps: ReportDeps = {}): Promise<boolean> {
  try {
    const taken = await db.rpc('analytics_take_checkout_ids', { p_order: order.id });
    if (taken.error) throw taken.error;
    const ids = parseGaCheckoutIds(taken.data);
    const config = gaServerConfig(deps.env);
    if (!ids || !config || order.method_transition === 'founder_renewal') return false;
    const url = `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(config.measurementId)}`
      + `&api_secret=${encodeURIComponent(config.apiSecret)}`;
    const response = await (deps.fetch ?? fetch)(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(purchaseEvent(order, ids, (deps.newId ?? randomUUID)())),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GA_MP_HTTP_${response.status}`);
    return true;
  } catch (error) {
    logger.warn('system', 'analytics_purchase_report_failed', { reason: error instanceof Error ? error.message.slice(0, 40) : 'unknown' });
    return false;
  }
}

/** The account withdrew statistics consent in the browser: drop its pending ids and remember when. */
export async function withdrawGaConsent(db: SupabaseClient, userId: string) {
  const result = await db.rpc('analytics_withdraw_consent', { p_user: userId });
  if (result.error) throw new Error('ANALYTICS_WITHDRAW_UNAVAILABLE', { cause: result.error });
}

/** The opened order's pre-tax amount in dollars for the browser's begin_checkout, or null (statistics only). */
export async function checkoutValue(db: SupabaseClient, userId: string, orderId: string): Promise<number | null> {
  try {
    const row = await db.from('payment_orders').select('amount_total').eq('id', orderId).eq('user_id', userId).maybeSingle();
    const cents = row.data?.amount_total;
    return row.error || typeof cents !== 'number' ? null : Number(centsToMajor(cents));
  } catch {
    return null;
  }
}

/** Daily clean-up of ids that were never taken (well past their 45-minute window). Best effort. */
export async function pruneGaCheckoutIds(db: SupabaseClient) {
  try {
    const result = await db.rpc('analytics_prune_checkout_ids');
    if (result.error) throw result.error;
    return { success: true, pruned: typeof result.data === 'number' ? result.data : 0 };
  } catch {
    return { success: false, pruned: 0 };
  }
}
