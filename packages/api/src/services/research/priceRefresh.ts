/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH price refresh (BENCHMARK-COVERAGE, controller 2026-10-23): research routes only run on a price entry that has
// not expired (TikHub ≤ 7 days, Parallel/Firecrawl ≤ 31 days, RESEARCH_TOOLS_PLAN §3.1), and nothing refreshed them, so
// every expiry silently switched the tools off. The daily billing job now re-reads each TikHub route's official
// endpoint_cost (TikHub's get_endpoint_info) and saves it through the existing price writer; Parallel and Firecrawl have
// no price API, so they are only reported before they expire. On staging the test window's frozen tool policies carry
// each price entry's hash; the database realigns them with the saved prices (research_test_window_sync_prices).
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { readProviderPrices, saveProviderPrices, type ProviderPriceEntry } from '../billingProviderPrices';
import { TIKHUB_BASE } from './vendors/tikhub';

const DAY_MS = 86_400_000;
/** TikHub prices are frozen for at most 7 days (plan §3.1); refreshed daily, one failed day never expires them. */
const TIKHUB_VALID_MS = 7 * DAY_MS;
const WARN_BEFORE_MS = DAY_MS;
const REQUEST_TIMEOUT_MS = 5_000;
/**
 * At most five requests per second (TikHub allows 10 per endpoint per second, shared with live traffic): a batch of five,
 * then the rest of that second. ~17 routes take about 4 s inside the daily job's 60 s.
 */
const BATCH = 5;
const BATCH_INTERVAL_MS = 1_000;
/** A rate-limited answer (429) gets one more try after this pause; a second 429 is a failure for the day. */
const RETRY_AFTER_MS = 1_500;
const PRICE = /^(0|[1-9]\d{0,5})(\.\d{1,9})?$/;

export interface PriceRefreshResult {
  success: boolean;
  refreshed: string[];
  /** Routes whose official price differs from the stored one (the new price applies to new calls only). */
  changed: Array<{ route: string; from: string; to: string }>;
  failed: Array<{ route: string; code: string }>;
  /** Entries (any provider) that expire within a day after this run: the research tools on them stop then. */
  expiring: Array<{ provider: string; route: string | null; validUntil: string }>;
  window: 'updated' | 'unchanged' | 'skipped' | 'failed';
}

export interface PriceRefreshDeps {
  readKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** The staging test window whose tool policies follow the prices; null outside staging. */
  windowId: string | null;
  sleep?: (ms: number) => Promise<void>;
}

/** One route's official price, or the reason it could not be read. Never throws. */
async function officialPrice(route: string, key: string, fetchImpl: typeof fetch) {
  const endpoint = `/api/v1${route}`;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${TIKHUB_BASE}/tikhub/user/get_endpoint_info?endpoint=${encodeURIComponent(endpoint)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal });
    const body = await response.text();
    if (response.status !== 200) return { ok: false as const, code: `HTTP_${response.status}` };
    const data = (JSON.parse(body) as { data?: { endpoint_uri?: unknown; endpoint_cost?: unknown } }).data;
    const cost = typeof data?.endpoint_cost === 'number' ? String(data.endpoint_cost) : null;
    if (data?.endpoint_uri !== endpoint || cost === null || !PRICE.test(cost) || Number(cost) <= 0) {
      return { ok: false as const, code: 'UNRECOGNIZED' };
    }
    return { ok: true as const, price: cost, evidenceHash: createHash('sha256').update(body).digest('hex') };
  } catch (error) {
    return { ok: false as const, code: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREADABLE' };
  }
}

const windowSync = z.object({ status: z.enum(['updated', 'unchanged', 'not_found', 'invalid']), synced: z.number().int(),
  skipped: z.array(z.object({ route: z.string(), reason: z.string() })) });

/**
 * Staging: the database realigns the window's TikHub policies with the stored prices (research_test_window_sync_prices,
 * the only write path to runtime_test_windows: price, expiry and entry hash come from the price table, not from here).
 * A route it could not price is left as it is and counts as a failure, so the daily job alerts before it expires.
 */
async function refreshWindow(db: SupabaseClient, windowId: string) {
  const { data, error } = await db.rpc('research_test_window_sync_prices', { p_window: windowId });
  const sync = windowSync.safeParse(data);
  if (error || !sync.success || sync.data.status === 'not_found' || sync.data.status === 'invalid') return { window: 'failed' as const };
  return { window: sync.data.skipped.length ? 'failed' as const : sync.data.status, skipped: sync.data.skipped };
}

export async function refreshResearchPrices(db: SupabaseClient, deps: PriceRefreshDeps): Promise<PriceRefreshResult> {
  const now = deps.now?.() ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const result: PriceRefreshResult = { success: false, refreshed: [], changed: [], failed: [], expiring: [], window: 'skipped' };
  const stored = await readProviderPrices(db);
  const routes = stored.config.entries.filter(entry => entry.provider === 'tikhub' && entry.route !== null).map(entry => entry.route!);
  let key: string | null = null;
  try { key = routes.length ? await deps.readKey() : null; } catch { key = null; }
  const fresh = new Map<string, ProviderPriceEntry>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const reads: Array<Awaited<ReturnType<typeof officialPrice>> | null> = [];
  for (let start = 0; key && start < routes.length; start += BATCH) {
    const begun = Date.now();
    reads.push(...await Promise.all(routes.slice(start, start + BATCH).map(async route => {
      const first = await officialPrice(route, key!, fetchImpl);
      if (first.ok || first.code !== 'HTTP_429') return first;
      await sleep(RETRY_AFTER_MS);
      return officialPrice(route, key!, fetchImpl);
    })));
    if (start + BATCH < routes.length) await sleep(Math.max(0, BATCH_INTERVAL_MS - (Date.now() - begun)));
  }
  for (const [index, route] of routes.entries()) {
    const read = reads[index] ?? null;
    if (!read) { result.failed.push({ route, code: 'KEY_UNAVAILABLE' }); continue; }
    if (!read.ok) { result.failed.push({ route, code: read.code }); continue; }
    const entry = stored.config.entries.find(item => item.provider === 'tikhub' && item.route === route)!;
    if (entry.price !== read.price) result.changed.push({ route, from: entry.price, to: read.price });
    fresh.set(route, { ...entry, price: read.price, evidenceHash: read.evidenceHash, verifiedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + TIKHUB_VALID_MS).toISOString(),
      pricingBasis: `official endpoint_cost from get_endpoint_info ${now.toISOString().slice(0, 10)} (daily refresh)` });
  }
  let prices = stored.config;
  if (fresh.size > 0) {
    const next = { ...stored.config, entries: stored.config.entries.map(entry =>
      (entry.provider === 'tikhub' && entry.route !== null ? fresh.get(entry.route) ?? entry : entry)) };
    try {
      prices = (await saveProviderPrices(db, next, stored.hash)).config;
      result.refreshed.push(...fresh.keys());
    } catch (error) {
      result.failed.push({ route: '*', code: error instanceof Error && 'code' in error ? String(error.code) : 'SAVE_FAILED' });
    }
  }
  let windowSkipped: Array<{ route: string; reason: string }> = [];
  if (deps.windowId && result.refreshed.length > 0) {
    try { const synced = await refreshWindow(db, deps.windowId); result.window = synced.window; windowSkipped = synced.skipped ?? []; }
    catch { result.window = 'failed'; }
  }
  for (const entry of prices.entries) {
    if (entry.validUntil !== null && Date.parse(entry.validUntil) - now.getTime() < WARN_BEFORE_MS) {
      result.expiring.push({ provider: entry.provider, route: entry.route, validUntil: entry.validUntil });
    }
  }
  result.success = result.failed.length === 0 && result.expiring.length === 0 && result.window !== 'failed';
  // Audit: what was read and saved (official evidence hashes stay in the entries themselves); no key, no body.
  logger[result.success ? 'info' : 'error']('billing', 'research_price_refresh', { refreshed: result.refreshed.length,
    changed: result.changed, failed: result.failed, expiring: result.expiring, window: result.window,
    ...(windowSkipped.length ? { windowSkipped } : {}) });
  return result;
}
