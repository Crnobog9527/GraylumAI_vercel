/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderPriceEntry, ProviderPrices } from '../billingProviderPrices';

const store = vi.hoisted(() => ({ config: null as unknown as ProviderPrices, saved: [] as unknown[], saveError: null as Error | null }));
vi.mock('../billingProviderPrices', async importOriginal => {
  const actual = await importOriginal<typeof import('../billingProviderPrices')>();
  return { ...actual,
    readProviderPrices: vi.fn(async () => ({ config: store.config, source: 'configured', hash: 'a'.repeat(64) })),
    saveProviderPrices: vi.fn(async (_db: unknown, input: unknown, hash: string | null) => {
      if (store.saveError) throw store.saveError;
      expect(hash).toBe('a'.repeat(64));
      store.saved.push(input);
      return { config: actual.parseProviderPrices(input), source: 'configured', hash: 'b'.repeat(64) };
    }) };
});
const { refreshResearchPrices } = await import('./priceRefresh');

const NOW = new Date('2026-10-24T04:00:00.000Z');
const entry = (provider: string, route: string, price: string, validUntil: string): ProviderPriceEntry => ({
  provider, route, appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: provider === 'tikhub' ? 'call' : 'sku_search',
  unitsPerPrice: '1', price, usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
  pricingBasis: 'official', sourceUrl: 'https://api.tikhub.io/api/v1/tikhub/user/get_endpoint_info', evidenceHash: 'c'.repeat(64),
  verifiedAt: '2026-10-18T00:00:00.000Z', validUntil, chargeCondition: 'one call', includedInReceipt: false, priceMultiplier: null,
} as ProviderPriceEntry);
const official = (costs: Record<string, number | string>) => vi.fn(async (url: string | URL | Request) => {
  const endpoint = new URL(String(url)).searchParams.get('endpoint')!;
  const cost = costs[endpoint.replace('/api/v1', '')];
  if (cost === 'fail') return new Response('nope', { status: 503 });
  return new Response(JSON.stringify({ code: 200, data: { endpoint_uri: endpoint, endpoint_cost: cost } }), { status: 200 });
}) as unknown as typeof fetch;

/** A database whose window sync answers `sync` (research_test_window_sync_prices); records each call. */
function windowDb(sync: unknown = { status: 'updated', synced: 1, skipped: [] }, error: unknown = null) {
  const calls: unknown[][] = [];
  const db = { rpc: vi.fn(async (...args: unknown[]) => { calls.push(args); return { data: sync, error }; }) } as unknown as SupabaseClient;
  return { db, calls };
}

beforeEach(() => {
  store.saved = [];
  store.saveError = null;
  store.config = { version: 1, entries: [
    entry('tikhub', '/tiktok/app/v3/handler_user_profile', '0.001', '2026-10-25T10:00:00.000Z'),
    entry('tikhub', '/douyin/app/v3/handler_user_profile', '0.01', '2026-10-25T10:00:00.000Z'),
    entry('parallel', 'parallel:search:fast', '1', '2026-11-18T09:00:00.000Z'),
  ] } as ProviderPrices;
});

describe('refreshResearchPrices', () => {
  it('saves every TikHub route at its official price for 7 more days and reports a changed price', async () => {
    const { db } = windowDb();
    const result = await refreshResearchPrices(db, { readKey: async () => 'key', windowId: null, now: () => NOW,
      fetchImpl: official({ '/tiktok/app/v3/handler_user_profile': 0.001, '/douyin/app/v3/handler_user_profile': 0.001 }) });
    expect(result).toMatchObject({ success: true, failed: [], expiring: [], window: 'skipped',
      changed: [{ route: '/douyin/app/v3/handler_user_profile', from: '0.01', to: '0.001' }] });
    const saved = store.saved[0] as ProviderPrices;
    expect(saved.entries.map(e => [e.route, e.price, e.validUntil])).toEqual([
      ['/tiktok/app/v3/handler_user_profile', '0.001', '2026-10-31T04:00:00.000Z'],
      ['/douyin/app/v3/handler_user_profile', '0.001', '2026-10-31T04:00:00.000Z'],
      ['parallel:search:fast', '1', '2026-11-18T09:00:00.000Z']]);
    expect(saved.entries[0]!.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a route it could not read, fails the run, and warns about what expires within a day', async () => {
    const { db } = windowDb();
    const result = await refreshResearchPrices(db, { readKey: async () => 'key', windowId: null,
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      fetchImpl: official({ '/tiktok/app/v3/handler_user_profile': 0.001, '/douyin/app/v3/handler_user_profile': 'fail' }) });
    expect(result.success).toBe(false);
    expect(result.failed).toEqual([{ route: '/douyin/app/v3/handler_user_profile', code: 'HTTP_503' }]);
    expect(result.expiring).toEqual([{ provider: 'tikhub', route: '/douyin/app/v3/handler_user_profile', validUntil: '2026-10-25T10:00:00.000Z' }]);
    expect((store.saved[0] as ProviderPrices).entries[1]!.price).toBe('0.01');
  });

  it('never sends without a key and never accepts an unrecognized or zero price', async () => {
    const fetchImpl = official({});
    const noKey = await refreshResearchPrices(windowDb().db, { readKey: async () => null, windowId: null, now: () => NOW, fetchImpl });
    expect(noKey.failed.map(f => f.code)).toEqual(['KEY_UNAVAILABLE', 'KEY_UNAVAILABLE']);
    expect(fetchImpl).not.toHaveBeenCalled();
    const bad = await refreshResearchPrices(windowDb().db, { readKey: async () => 'key', windowId: null, now: () => NOW,
      fetchImpl: official({ '/tiktok/app/v3/handler_user_profile': 0, '/douyin/app/v3/handler_user_profile': '0.01' }) });
    expect(bad.failed.map(f => f.code)).toEqual(['UNRECOGNIZED', 'UNRECOGNIZED']);
    expect(store.saved).toHaveLength(0);
  });

  it('asks the database to realign the staging window with the saved prices, and alerts when it could not', async () => {
    const run = (db: SupabaseClient) => refreshResearchPrices(db, { readKey: async () => 'key', windowId: '897525f9-66f1-4504-8d91-a52d2c0f0e60',
      now: () => NOW, fetchImpl: official({ '/tiktok/app/v3/handler_user_profile': 0.001, '/douyin/app/v3/handler_user_profile': 0.01 }) });
    const updated = windowDb();
    expect(await run(updated.db)).toMatchObject({ success: true, window: 'updated' });
    // Only the window id goes to the database: no price, hash or policy is sent from here.
    expect(updated.calls).toEqual([['research_test_window_sync_prices', { p_window: '897525f9-66f1-4504-8d91-a52d2c0f0e60' }]]);
    expect(await run(windowDb({ status: 'unchanged', synced: 2, skipped: [] }).db)).toMatchObject({ success: true, window: 'unchanged' });
    // A route left unpriced, a missing window, a malformed answer or a database error fails the day (the job alerts).
    for (const db of [windowDb({ status: 'updated', synced: 1, skipped: [{ route: '/x', reason: 'PRICE_EXPIRED' }] }).db,
      windowDb({ status: 'not_found', synced: 0, skipped: [] }).db, windowDb({ status: 'weird' }).db,
      windowDb(null, { message: 'permission denied' }).db]) {
      expect(await run(db)).toMatchObject({ success: false, window: 'failed' });
    }
  });

  it('sends at most five requests per second and retries a 429 once', async () => {
    store.config = { version: 1, entries: Array.from({ length: 7 }, (_, i) =>
      entry('tikhub', `/tiktok/app/v3/route_${i}`, '0.001', '2026-10-30T00:00:00.000Z')) } as ProviderPrices;
    const order: string[] = [];
    let limited = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const endpoint = new URL(String(url)).searchParams.get('endpoint')!;
      order.push(endpoint.slice(-7));
      if (endpoint.endsWith('route_6') && limited) { limited = false; return new Response('slow down', { status: 429 }); }
      return new Response(JSON.stringify({ data: { endpoint_uri: endpoint, endpoint_cost: 0.001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async (ms: number) => { order.push(`sleep ${ms > 1_200 ? 'retry' : 'second'}`); });
    const result = await refreshResearchPrices(windowDb().db, { readKey: async () => 'key', windowId: null, now: () => NOW,
      fetchImpl, sleep });
    expect(result).toMatchObject({ success: true, failed: [] });
    expect(order.slice(0, 6)).toEqual(['route_0', 'route_1', 'route_2', 'route_3', 'route_4', 'sleep second']);
    expect(order.slice(6)).toEqual(['route_5', 'route_6', 'sleep retry', 'route_6']);
  });

  it('reports a failed save instead of a refresh', async () => {
    store.saveError = new Error('conflict');
    const result = await refreshResearchPrices(windowDb().db, { readKey: async () => 'key', windowId: null, now: () => NOW,
      fetchImpl: official({ '/tiktok/app/v3/handler_user_profile': 0.001, '/douyin/app/v3/handler_user_profile': 0.01 }) });
    expect(result).toMatchObject({ success: false, refreshed: [], failed: [{ route: '*', code: 'SAVE_FAILED' }] });
  });
});
