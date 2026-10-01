/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMultiplierSnapshot, multiplierForCall, multiplierForProviderCall, readMultiplierSnapshot } from './billingUnit';
import {
  parseProviderPrices,
  resolveProviderMultipliers,
  providerUsageCostUsd,
  readProviderPrices,
  resolveProviderPrice,
  saveProviderPrices,
  type ProviderPriceEntry,
} from './billingProviderPrices';

const HASH = 'a'.repeat(64);
const AT = new Date('2026-10-02T00:00:00Z');
function entry(overrides: Partial<ProviderPriceEntry> = {}): ProviderPriceEntry {
  return {
    provider: 'parallel', route: 'search/basic', appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'request',
    unitsPerPrice: '1000', price: '5', usdPerCurrency: null, pricingBasis: 'list-price',
    sourceUrl: 'https://docs.parallel.ai/getting-started/pricing', evidenceHash: HASH,
    verifiedAt: '2026-10-01T00:00:00Z', validUntil: null, chargeCondition: 'successful search response',
    includedInReceipt: false, priceMultiplier: null, ...overrides,
  };
}
const config = (...entries: ProviderPriceEntry[]) => ({ version: 1 as const, entries });

describe('provider price configuration', () => {
  it('accepts a bounded, evidenced configuration and a JSON string form', () => {
    const value = config(entry(), entry({ provider: 'firecrawl', route: null, appliesToUnlistedRoutes: true, priceMultiplier: '2.5' }));
    expect(parseProviderPrices(value)).toEqual(value);
    expect(parseProviderPrices(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ['unknown field such as a key', { ...entry(), apiKey: 'sk-x' }],
    ['USD with an exchange rate', entry({ usdPerCurrency: '1' })],
    ['non-USD without a rate', entry({ currency: 'CNY' })],
    ['route entry covering unlisted routes', entry({ appliesToUnlistedRoutes: true })],
    ['validUntil before verifiedAt', entry({ validUntil: '2026-09-01T00:00:00Z' })],
    ['multiplier out of range', entry({ priceMultiplier: '20.01' })],
    ['over-precise multiplier', entry({ priceMultiplier: '1.234' })],
    ['http source', entry({ sourceUrl: 'http://example.com/pricing' })],
    ['negative price', entry({ price: '-1' })],
    ['zero denominator', entry({ unitsPerPrice: '0' })],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseProviderPrices(config(bad as ProviderPriceEntry))).toThrow('PROVIDER_PRICES_INVALID');
  });

  it('rejects duplicate provider/route pairs and oversized lists', () => {
    expect(() => parseProviderPrices(config(entry(), entry()))).toThrow('PROVIDER_PRICES_INVALID');
    const many = Array.from({ length: 65 }, (_, i) => entry({ route: `r${i}` }));
    expect(() => parseProviderPrices(config(...many))).toThrow('PROVIDER_PRICES_INVALID');
    expect(() => parseProviderPrices('{not json')).toThrow('PROVIDER_PRICES_INVALID');
  });
});

describe('route resolution and multiplier inheritance', () => {
  const wide = entry({ route: null, appliesToUnlistedRoutes: true, priceMultiplier: '5' });

  it('prefers the exact route; its NULL multiplier inherits the site default, not the provider-wide override', () => {
    const resolved = resolveProviderPrice(config(wide, entry()), { provider: 'parallel', route: 'search/basic' }, '3', AT);
    expect(resolved).toMatchObject({ matchedBy: 'route', multiplier: '3', multiplierSource: 'global' });
  });

  it('uses the provider-wide entry only when it explicitly covers unlisted routes', () => {
    expect(resolveProviderPrice(config(wide), { provider: 'parallel', route: 'search/fast' }, '3', AT))
      .toMatchObject({ matchedBy: 'provider', multiplier: '5', multiplierSource: 'provider' });
    const closed = entry({ route: null, appliesToUnlistedRoutes: false });
    expect(() => resolveProviderPrice(config(closed), { provider: 'parallel', route: 'search/fast' }, '3', AT))
      .toThrow('PROVIDER_PRICE_UNKNOWN');
  });

  it('unknown providers, expired and not-yet-verified prices are refused', () => {
    expect(() => resolveProviderPrice(config(entry()), { provider: 'tikhub', route: 'x' }, '3', AT)).toThrow('PRICE_UNKNOWN');
    expect(() => resolveProviderPrice(config(), { provider: 'parallel', route: 'search/basic' }, '3', AT)).toThrow('PRICE_UNKNOWN');
    const expired = entry({ validUntil: '2026-10-01T12:00:00Z' });
    expect(() => resolveProviderPrice(config(expired), { provider: 'parallel', route: 'search/basic' }, '3', AT)).toThrow('EXPIRED');
    const future = entry({ verifiedAt: '2026-10-03T00:00:00Z' });
    expect(() => resolveProviderPrice(config(future), { provider: 'parallel', route: 'search/basic' }, '3', AT)).toThrow('EXPIRED');
  });

  it('the entry hash changes with any priced field', () => {
    const a = resolveProviderPrice(config(entry()), { provider: 'parallel', route: 'search/basic' }, '3', AT);
    const b = resolveProviderPrice(config(entry({ price: '6' })), { provider: 'parallel', route: 'search/basic' }, '3', AT);
    expect(a.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.entryHash).not.toBe(b.entryHash);
  });
});

describe('official usage to USD', () => {
  const at = (value: ProviderPriceEntry) => resolveProviderPrice(config(value), { provider: value.provider, route: value.route ?? 'x' }, '3', AT);

  it('converts per-thousand, per-credit and foreign-currency prices exactly', () => {
    expect(providerUsageCostUsd(at(entry()), '1')).toBe('0.005');
    const firecrawl = entry({ provider: 'firecrawl', route: 'scrape', usageUnit: 'firecrawl-credit', unitsPerPrice: '5000', price: '19' });
    expect(providerUsageCostUsd(at(firecrawl), '2')).toBe('0.0076');
    const cny = entry({ provider: 'tikhub', route: 'v1/user', currency: 'CNY', usdPerCurrency: '0.14', unitsPerPrice: '1', price: '1.5' });
    expect(providerUsageCostUsd(at(cny), '1')).toBe('0.21');
    expect(providerUsageCostUsd(at(entry()), '0')).toBe('0');
  });

  it('rounds a non-terminating cost up to the 12-decimal USD unit, never down', () => {
    const third = entry({ unitsPerPrice: '3', price: '1' });
    expect(providerUsageCostUsd(at(third), '1')).toBe('0.333333333334');
  });

  it('does not charge a cost that is already inside another receipt', () => {
    expect(providerUsageCostUsd(at(entry({ includedInReceipt: true })), '10')).toBeNull();
  });

  it.each(['-1', '1e3', 'abc', ''])('rejects usage %j', (usage) => {
    expect(() => providerUsageCostUsd(at(entry()), usage)).toThrow('PROVIDER_USAGE_INVALID');
  });
});

describe('read and save', () => {
  function db(read: { data: unknown; error: unknown } | Error, writeError: unknown = null) {
    const writes: unknown[] = [];
    let stored = read;
    const client = { from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => {
        if (stored instanceof Error) throw stored;
        return stored;
      } }) }),
      upsert: async (row: { value: string }) => {
        writes.push(row);
        if (!writeError) stored = { data: { value: row.value }, error: null };
        return { error: writeError };
      },
    }) };
    return { client: client as unknown as SupabaseClient, writes };
  }

  it('absent configuration prices nothing; read failures and invalid stored values are errors', async () => {
    await expect(readProviderPrices(db({ data: null, error: null }).client)).resolves.toEqual({
      config: { version: 1, entries: [] }, source: 'absent' });
    await expect(readProviderPrices(db({ data: null, error: { code: 'x' } }).client)).rejects.toThrow('UNAVAILABLE');
    await expect(readProviderPrices(db(new Error('network')).client)).rejects.toThrow('UNAVAILABLE');
    await expect(readProviderPrices(db({ data: { value: '{"version":2}' }, error: null }).client)).rejects.toThrow('INVALID');
  });

  it('validates before writing and reads back after', async () => {
    const ok = db({ data: null, error: null });
    await expect(saveProviderPrices(ok.client, config(entry()))).resolves.toMatchObject({ source: 'configured' });
    const bad = db({ data: null, error: null });
    await expect(saveProviderPrices(bad.client, config(entry({ price: 'x' })))).rejects.toThrow('INVALID');
    expect(bad.writes).toEqual([]);
    await expect(saveProviderPrices(db({ data: null, error: null }, { code: 'x' }).client, config(entry())))
      .rejects.toThrow('UNAVAILABLE');
  });
});

describe('operation snapshot with third-party routes', () => {
  const prices = config(
    entry(),
    entry({ provider: 'firecrawl', route: 'scrape', usageUnit: 'firecrawl-credit', unitsPerPrice: '5000', price: '19', priceMultiplier: '2' }),
  );
  const routes = [{ provider: 'parallel', route: 'search/basic' }, { provider: 'firecrawl', route: 'scrape' }];

  it('freezes model and route multipliers together; only approved routes are chargeable', async () => {
    const tables: Record<string, unknown> = {
      system_settings: { data: [{ key: 'billing_token_price_multiplier', value: '3' }], error: null },
      ai_models: { data: [{ id: 'm', price_multiplier: null }], error: null },
    };
    const db = { from: (table: string) => ({ select: () => ({ in: async () => tables[table] }) }) } as unknown as SupabaseClient;
    const snapshot = await readMultiplierSnapshot(db, ['m'], (fallback) => resolveProviderMultipliers(prices, routes, fallback, AT));
    expect(snapshot.providers).toEqual({
      'firecrawl scrape': { multiplier: '2', source: 'provider' },
      'parallel search/basic': { multiplier: '3', source: 'global' },
    });
    expect(multiplierForCall(snapshot, 'm')).toMatchObject({ multiplier: '3', source: 'global' });
    expect(multiplierForProviderCall(snapshot, 'firecrawl', 'scrape')).toMatchObject({ multiplier: '2', source: 'provider' });
    expect(() => multiplierForProviderCall(snapshot, 'parallel', 'search/fast')).toThrow('ROUTE_NOT_APPROVED');
    const tampered = { ...snapshot, providers: { ...snapshot.providers, 'firecrawl scrape': { multiplier: '1', source: 'provider' as const } } };
    expect(() => multiplierForProviderCall(tampered, 'firecrawl', 'scrape')).toThrow('SNAPSHOT_INVALID');
  });

  it('a route-only operation needs no model, and an unpriced route blocks the whole snapshot', async () => {
    const db = { from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }) } as unknown as SupabaseClient;
    const snapshot = await readMultiplierSnapshot(db, [], (fallback) => resolveProviderMultipliers(prices, routes.slice(0, 1), fallback, AT));
    expect(snapshot.models).toEqual({});
    await expect(readMultiplierSnapshot(db, [], (fallback) =>
      resolveProviderMultipliers(prices, [{ provider: 'tikhub', route: 'x' }], fallback, AT))).rejects.toThrow('PRICE_UNKNOWN');
  });

  it('sources cannot be mixed between the model and route maps', () => {
    const settings = { creditsPerUsd: '100', defaultMultiplier: '3' };
    expect(() => buildMultiplierSnapshot(settings, { m: { multiplier: '2', source: 'provider' } })).toThrow('SNAPSHOT_INVALID');
    expect(() => buildMultiplierSnapshot(settings, {}, { 'p r': { multiplier: '2', source: 'model' } })).toThrow('SNAPSHOT_INVALID');
    expect(() => buildMultiplierSnapshot(settings, {}, {})).toThrow('SNAPSHOT_INVALID');
  });
});
