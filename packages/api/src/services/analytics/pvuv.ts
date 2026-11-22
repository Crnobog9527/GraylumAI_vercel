/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { purchaseSnapshotSchema } from '../payments/contracts';
import { centsToMajor } from '../payments/purchaseFacts';

/**
 * ANALYTICS-PVUV (Owner 2026-11-22): server events to pvuv.ai (`POST /v1/sites/<site>/events`, ingest-only bearer token).
 * Events: signup, checkout_start, checkout_cancel, purchase. Each carries the account's opaque id as `user_id`, and the
 * browser's `_pv_id` as `visitor_id` when the request has it (that cookie exists only while the browser's statistics consent
 * is live: a refusal clears it), and a dedupe `id`, so a retry or a replayed webhook is ignored by pvuv.ai.
 * Statistics only: nothing here throws, retries or changes money. A failure is logged and dropped; the call is time-boxed.
 * Without `PVUV_SITE` and `PVUV_INGEST_TOKEN` everything is off.
 */
const SITE = /^[A-Za-z0-9_-]{4,64}$/;
const VISITOR_ID = /^[A-Za-z0-9_.-]{8,64}$/;
const TIMEOUT_MS = 2500;

export type PvuvServerConfig = { site: string; token: string };

export function pvuvServerConfig(env: Record<string, string | undefined> = process.env): PvuvServerConfig | null {
  const site = env.PVUV_SITE?.trim() ?? '';
  const token = env.PVUV_INGEST_TOKEN?.trim() ?? '';
  return SITE.test(site) && token.length >= 8 ? { site, token } : null;
}

export type PvuvEvent = {
  name: 'signup' | 'checkout_start' | 'checkout_cancel' | 'purchase';
  user_id: string;
  visitor_id?: string;
  id: string;
  revenue?: number;
  currency?: 'USD';
  props?: Record<string, string | number | boolean>;
};

/** 8–64 characters, as pvuv.ai requires: a long source id is hashed. */
export function pvuvEventId(prefix: string, raw: string): string {
  const id = `${prefix}-${raw}`;
  return id.length <= 64 ? id.padEnd(8, '_') : `${prefix}-${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

/** The browser's visitor id from the request's cookies (null when absent or malformed). */
export function pvuvVisitorId(headers: Headers | undefined | null): string | null {
  const cookie = headers?.get('cookie') ?? '';
  const match = /(?:^|;\s*)_pv_id=([^;]*)/.exec(cookie);
  if (!match) return null;
  let value = match[1];
  try { value = decodeURIComponent(value); } catch { return null; }
  return VISITOR_ID.test(value) ? value : null;
}

type SendDeps = { fetch?: typeof fetch; env?: Record<string, string | undefined> };

/** Sends one event. Never throws; resolves true only when pvuv.ai accepted the request. */
export async function sendPvuvEvent(event: PvuvEvent, deps: SendDeps = {}): Promise<boolean> {
  try {
    const config = pvuvServerConfig(deps.env);
    if (!config) return false;
    const response = await (deps.fetch ?? fetch)(`https://api.pvuv.ai/v1/sites/${encodeURIComponent(config.site)}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ ...event, ts: Date.now() }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`PVUV_HTTP_${response.status}`);
    return true;
  } catch (error) {
    logger.warn('system', 'pvuv_event_failed', { event: event.name, reason: error instanceof Error ? error.message.slice(0, 40) : 'unknown' });
    return false;
  }
}

type Scheduler = (task: () => Promise<unknown>) => void;
let registered: Scheduler | null = null;

/** The web app registers Next's `after` here, so payment code can queue statistics without ever awaiting them. */
export function registerPvuvScheduler(scheduler: Scheduler | null): void {
  registered = scheduler;
}

/** The whole statistics task (database reads and the send) is cut off after this long. */
export const PVUV_TASK_LIMIT_MS = 2500;

/**
 * Queues `task` and returns at once; it is never awaited by the caller, so a slow database or a slow pvuv.ai can never delay
 * a payment, a webhook receipt or a sign-up. It runs after the response when a scheduler exists (the caller's `scheduleAfter`,
 * or the registered one), else detached. The whole task, reads included, is limited to PVUV_TASK_LIMIT_MS; errors are logged.
 */
export function dispatchPvuv(task: () => Promise<unknown>, scheduleAfter?: Scheduler): void {
  if (!pvuvServerConfig()) return;
  const safe = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PVUV_TASK_TIMEOUT')), PVUV_TASK_LIMIT_MS); }),
      ]);
    } catch (error) {
      logger.warn('system', 'pvuv_event_failed', { reason: error instanceof Error ? error.message.slice(0, 40) : 'unknown' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const scheduler = scheduleAfter ?? registered;
  if (scheduler) {
    try { scheduler(safe); return; } catch { /* not inside a request: run detached */ }
  }
  void safe();
}

export type SignupMethod = 'google' | 'phone' | 'email';

export function signupEvent(userId: string, method: SignupMethod, visitorId: string | null): PvuvEvent {
  return { name: 'signup', user_id: userId, ...(visitorId ? { visitor_id: visitorId } : {}),
    id: pvuvEventId('signup', userId), props: { method } };
}

type OrderRow = {
  id: string; user_id: string | null; item_id: string; item_type: string; billing_cycle: string; amount_total: number | null;
  offer_kind?: string | null; payment_channel?: string | null; payment_method?: string | null; method_transition?: string | null;
  purchase_snapshot?: unknown;
};

export const ORDER_COLUMNS = ['id', 'user_id', 'item_id', 'item_type', 'billing_cycle', 'amount_total', 'offer_kind', 'payment_channel',
  'payment_method', 'method_transition', 'purchase_snapshot'].join(',');

/** The credits the buyer was sold, from the order's frozen purchase snapshot (never today's catalog); omitted when unreadable. */
export function snapshotCredits(snapshot: unknown): number | undefined {
  const parsed = purchaseSnapshotSchema.safeParse(snapshot);
  return parsed.success ? parsed.data.credits + parsed.data.bonus_credits : undefined;
}

/** The plan's tier (a label only; unreadable = omitted). */
async function planTier(db: SupabaseClient, order: OrderRow): Promise<string | undefined> {
  if (order.item_type !== 'membership_plan') return undefined;
  try {
    const plan = await db.from('membership_plans').select('level').eq('id', order.item_id).maybeSingle();
    return plan.error || !plan.data ? undefined : String(plan.data.level);
  } catch {
    return undefined;
  }
}

export type OrderEventKind = 'checkout_start' | 'checkout_cancel' | 'purchase';

/**
 * The event for an order. `dedupeSource` is the checkout id or payment id. Revenue is the order's pre-tax amount in USD
 * (what GA's purchase also reports). Carries product, tier, interval, channel, method and discount, never an email or name.
 */
export async function orderEvent(db: SupabaseClient, order: OrderRow, kind: OrderEventKind, dedupeSource: string,
  visitorId: string | null): Promise<PvuvEvent | null> {
  if (!order.user_id) return null;
  const tier = await planTier(db, order);
  const credits = snapshotCredits(order.purchase_snapshot);
  const renewal = order.method_transition === 'founder_renewal' || order.method_transition === 'wallet_renewal';
  const props: Record<string, string | number | boolean> = {
    product: order.item_type, interval: order.billing_cycle, channel: order.payment_channel ?? 'stripe',
    method: order.payment_method ?? 'unknown', discount: order.offer_kind ?? 'none',
    ...(tier ? { tier } : {}), ...(renewal ? { renewal: true } : {}),
    ...(kind === 'purchase' && credits !== undefined ? { credits } : {}),
  };
  return {
    name: kind, user_id: order.user_id, ...(visitorId ? { visitor_id: visitorId } : {}),
    id: pvuvEventId(kind.replace('_', '-'), dedupeSource), props,
    ...(kind === 'purchase' && typeof order.amount_total === 'number'
      ? { revenue: Number(centsToMajor(order.amount_total)), currency: 'USD' as const } : {}),
  };
}

/** Loads an order by id (and owner when given) and reports `kind` for it. Never throws. */
export function reportOrderEvent(db: SupabaseClient, orderId: string, kind: OrderEventKind, dedupeSource: string,
  options: { userId?: string; visitorId?: string | null; scheduleAfter?: (task: () => Promise<unknown>) => void; order?: OrderRow } = {}): void {
  dispatchPvuv(async () => {
    let order = options.order ?? null;
    if (!order) {
      let query = db.from('payment_orders').select(ORDER_COLUMNS).eq('id', orderId);
      if (options.userId) query = query.eq('user_id', options.userId);
      const row = await query.maybeSingle();
      if (row.error || !row.data) return;
      order = row.data as unknown as OrderRow;
    }
    const event = await orderEvent(db, order, kind, dedupeSource, options.visitorId ?? null);
    if (event) await sendPvuvEvent(event);
  }, options.scheduleAfter);
}
