/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMultiplierSnapshot, multiplierForCall, multiplierForProviderCall, readMultiplierSnapshot } from './billingUnit';
import { weightedAggregateCredits } from './bill2/weighted';
import {
  parseProviderPrices,
  providerPricesView,
  providerUsageCostUsd,
  readProviderPrices,
  resolveProviderMultipliers,
  resolveProviderPrice,
  saveProviderPrices,
  type ProviderPriceEntry,
} from './billingProviderPrices';

const HASH = 'a'.repeat(64);
const AT = new Date('2026-10-02T00:00:00Z');
function entry(overrides: Partial<ProviderPriceEntry> = {}): ProviderPriceEntry {
  return {
    provider: 'parallel', route: 'search/basic', appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'request',
    unitsPerPrice: '1000', price: '5', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
    pricingBasis: 'list-price', sourceUrl: 'https://docs.parallel.ai/getting-started/pricing', evidenceHash: HASH,
    verifiedAt: '2026-10-01T00:00:00Z', validUntil: null, chargeCondition: 'successful search response',
    includedInReceipt: false, priceMultiplier: null, ...overrides,
  };
}
const fx = { currency: 'CNY', usdPerCurrency: '0.14', fxSourceUrl: 'https://www.example.org/fx/cny',
  fxEffectiveAt: '2026-10-01T00:00:00Z', fxValidUntil: '2026-10-08T00:00:00Z' };
const config = (...entries: ProviderPriceEntry[]) => ({ version: 1 as const, entries });
const resolve = (value: ProviderPriceEntry, at = AT) =>
  resolveProviderPrice(config(value), { provider: value.provider, route: value.route ?? 'x' }, '3', at);

describe('provider price configuration', () => {
  it('accepts a bounded, evidenced configuration and a JSON string form', () => {
    const value = config(entry(), entry({ provider: 'firecrawl', route: null, appliesToUnlistedRoutes: true, priceMultiplier: '2.5' }),
      entry({ provider: 'tikhub', route: 'v1/user', ...fx }));
    expect(parseProviderPrices(value)).toEqual(value);
    expect(parseProviderPrices(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ['unknown field such as a key', { ...entry(), apiKey: 'sk-x' }],
    ['USD with an exchange rate', entry({ usdPerCurrency: '1' })],
    ['USD with FX evidence', entry({ fxSourceUrl: 'https://www.example.org/fx' })],
    ['non-USD without a rate', entry({ ...fx, usdPerCurrency: null })],
    ['non-USD without FX source', entry({ ...fx, fxSourceUrl: null })],
    ['non-USD without FX effective date', entry({ ...fx, fxEffectiveAt: null })],
    ['non-USD without FX expiry', entry({ ...fx, fxValidUntil: null })],
    ['FX expiry before effective date', entry({ ...fx, fxValidUntil: '2026-09-01T00:00:00Z' })],
    ['FX valid for more than 31 days', entry({ ...fx, fxValidUntil: '2026-11-01T00:00:01Z' })],
    ['route entry covering unlisted routes', entry({ appliesToUnlistedRoutes: true })],
    ['provider-wide entry covering nothing', entry({ route: null, appliesToUnlistedRoutes: false })],
    ['validUntil before verifiedAt', entry({ validUntil: '2026-09-01T00:00:00Z' })],
    ['multiplier out of range', entry({ priceMultiplier: '20.01' })],
    ['over-precise multiplier', entry({ priceMultiplier: '1.234' })],
    ['http source', entry({ sourceUrl: 'http://example.com/pricing' })],
    ['source with credentials', entry({ sourceUrl: 'https://user:pw@example.com/pricing' })],
    ['source with a query string', entry({ sourceUrl: 'https://example.com/pricing?ref=x' })],
    ['source with a fragment', entry({ sourceUrl: 'https://example.com/pricing#plans' })],
    ['negative price', entry({ price: '-1' })],
    ['zero denominator', entry({ unitsPerPrice: '0' })],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseProviderPrices(config(bad as ProviderPriceEntry))).toThrow('PROVIDER_PRICES_INVALID');
  });

  it('accepts an exchange rate valid for exactly 31 days', () => {
    expect(() => parseProviderPrices(config(entry({ ...fx, fxValidUntil: '2026-11-01T00:00:00Z' })))).not.toThrow();
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

  it('uses the provider-wide entry only for routes without their own entry', () => {
    expect(resolveProviderPrice(config(wide), { provider: 'parallel', route: 'search/fast' }, '3', AT))
      .toMatchObject({ matchedBy: 'provider', multiplier: '5', multiplierSource: 'provider' });
  });

  it('an expired exact route is refused even when a provider-wide entry is valid', () => {
    const expired = entry({ validUntil: '2026-10-01T12:00:00Z' });
    expect(() => resolveProviderPrice(config(wide, expired), { provider: 'parallel', route: 'search/basic' }, '3', AT))
      .toThrow('EXPIRED');
  });

  it('unknown providers, expired, not-yet-verified prices, expired FX and an invalid clock are refused', () => {
    expect(() => resolveProviderPrice(config(entry()), { provider: 'tikhub', route: 'x' }, '3', AT)).toThrow('PRICE_UNKNOWN');
    expect(() => resolveProviderPrice(config(), { provider: 'parallel', route: 'search/basic' }, '3', AT)).toThrow('PRICE_UNKNOWN');
    expect(() => resolve(entry({ validUntil: '2026-10-01T12:00:00Z' }))).toThrow('EXPIRED');
    expect(() => resolve(entry({ verifiedAt: '2026-10-03T00:00:00Z' }))).toThrow('EXPIRED');
    expect(() => resolve(entry({ provider: 'tikhub', route: 'v1/user', ...fx }), new Date('2026-10-09T00:00:00Z'))).toThrow('EXPIRED');
    expect(() => resolve(entry({ provider: 'tikhub', route: 'v1/user', ...fx, fxEffectiveAt: '2026-10-03T00:00:00Z',
      fxValidUntil: '2026-10-09T00:00:00Z' }))).toThrow('EXPIRED');
    expect(() => resolve(entry(), new Date('not a date'))).toThrow('EXPIRED');
  });

  it('the entry hash changes with any priced field', () => {
    expect(resolve(entry()).entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolve(entry()).entryHash).not.toBe(resolve(entry({ price: '6' })).entryHash);
  });
});

describe('official usage to USD', () => {
  it('converts per-thousand, per-credit and foreign-currency prices exactly', () => {
    expect(providerUsageCostUsd(resolve(entry()), '1', 'down').costUsd).toBe('0.005');
    const firecrawl = entry({ provider: 'firecrawl', route: 'scrape', usageUnit: 'firecrawl-credit', unitsPerPrice: '5000', price: '19' });
    expect(providerUsageCostUsd(resolve(firecrawl), '2', 'down').costUsd).toBe('0.0076');
    const cny = entry({ provider: 'tikhub', route: 'v1/user', ...fx, unitsPerPrice: '1', price: '1.5' });
    expect(providerUsageCostUsd(resolve(cny), '1', 'down').costUsd).toBe('0.21');
    expect(providerUsageCostUsd(resolve(entry()), '0', 'up').costUsd).toBe('0');
  });

  it('upper bounds round up, actual costs round down', () => {
    const third = resolve(entry({ unitsPerPrice: '3', price: '1' }));
    expect(providerUsageCostUsd(third, '1', 'up').costUsd).toBe('0.333333333334');
    expect(providerUsageCostUsd(third, '1', 'down').costUsd).toBe('0.333333333333');
  });

  it('regression: 5 calls at $16 / 3000 units, m=3, q=100 charge exactly 8 credits, not 9', () => {
    const price = resolve(entry({ unitsPerPrice: '3000', price: '16' }));
    const calls = (rounding: 'up' | 'down') => Array.from({ length: 5 }, () =>
      ({ costUsd: providerUsageCostUsd(price, '1', rounding).costUsd!, multiplier: '3' }));
    expect(weightedAggregateCredits(calls('down'), '100')).toBe(8);
    expect(weightedAggregateCredits(calls('up'), '100')).toBe(9);
  });

  it('a cost already inside another receipt is not charged, with the reason and frozen entry hash', () => {
    const price = resolve(entry({ includedInReceipt: true }));
    expect(providerUsageCostUsd(price, '10', 'down')).toEqual({ costUsd: null, reason: 'included_in_receipt', entryHash: price.entryHash });
  });

  it.each(['-1', '1e3', 'abc', ''])('rejects usage %j', (usage) => {
    expect(() => providerUsageCostUsd(resolve(entry()), usage, 'down')).toThrow('PROVIDER_USAGE_INVALID');
  });

  it('rejects an amount beyond the 12-digit USD range', () => {
    const huge = resolve(entry({ unitsPerPrice: '1', price: '999999999999' }));
    expect(() => providerUsageCostUsd(huge, '999999999999', 'up')).toThrow('PROVIDER_USAGE_INVALID');
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
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  it('absent configuration prices nothing; read failures are errors; invalid stored values are named as such', async () => {
    await expect(readProviderPrices(db({ data: null, error: null }).client)).resolves.toEqual({
      config: { version: 1, entries: [] }, source: 'absent', hash: null });
    await expect(readProviderPrices(db({ data: null, error: { code: 'x' } }).client)).rejects.toThrow('UNAVAILABLE');
    await expect(readProviderPrices(db(new Error('network')).client)).rejects.toThrow('UNAVAILABLE');
    await expect(readProviderPrices(db({ data: { value: '{"version":2}' }, error: null }).client)).rejects.toThrow('STORED_INVALID');
    await expect(providerPricesView(db({ data: { value: '{"version":2}' }, error: null }).client))
      .resolves.toEqual({ config: null, source: 'invalid', hash: sha('{"version":2}') });
  });

  it('validates, checks the expected hash, writes and reads back', async () => {
    const ok = db({ data: null, error: null });
    const saved = await saveProviderPrices(ok.client, config(entry()), null);
    expect(saved).toMatchObject({ source: 'configured', hash: sha(JSON.stringify(config(entry()))) });
    await expect(saveProviderPrices(ok.client, config(entry({ price: '6' })), saved.hash)).resolves.toMatchObject({ source: 'configured' });
    expect(ok.writes).toHaveLength(2);
  });

  it('a stale or missing expected hash is a conflict and writes nothing', async () => {
    const stored = db({ data: { value: JSON.stringify(config(entry())) }, error: null });
    await expect(saveProviderPrices(stored.client, config(entry({ price: '6' })), null)).rejects.toThrow('CONFLICT');
    await expect(saveProviderPrices(stored.client, config(entry({ price: '6' })), 'b'.repeat(64))).rejects.toThrow('CONFLICT');
    expect(stored.writes).toEqual([]);
  });

  it('an invalid stored value can be replaced by quoting its hash', async () => {
    const broken = db({ data: { value: '{"version":2}' }, error: null });
    await expect(saveProviderPrices(broken.client, config(entry()), sha('{"version":2}'))).resolves.toMatchObject({ source: 'configured' });
  });

  it('invalid input and write failures write nothing or report unavailable', async () => {
    const bad = db({ data: null, error: null });
    await expect(saveProviderPrices(bad.client, config(entry({ price: 'x' })), null)).rejects.toThrow('INVALID');
    expect(bad.writes).toEqual([]);
    await expect(saveProviderPrices(db({ data: null, error: null }, { code: 'x' }).client, config(entry()), null))
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
    const client = { from: (table: string) => ({ select: () => ({ in: async () => tables[table] }) }) } as unknown as SupabaseClient;
    const snapshot = await readMultiplierSnapshot(client, ['m'], (fallback) => resolveProviderMultipliers(prices, routes, fallback, AT));
    expect(snapshot.version).toBe('bill-unit-v2');
    expect(snapshot.providers).toEqual({
      'firecrawl scrape': { multiplier: '2', source: 'provider' },
      'parallel search/basic': { multiplier: '3', source: 'global' },
    });
    expect(multiplierForCall(snapshot, 'm')).toMatchObject({ multiplier: '3', source: 'global' });
    expect(multiplierForProviderCall(snapshot, 'firecrawl', 'scrape')).toMatchObject({ multiplier: '2', source: 'provider' });
    expect(() => multiplierForProviderCall(snapshot, 'parallel', 'search/fast')).toThrow('ROUTE_NOT_APPROVED');
    const tampered = { ...snapshot, providers: { ...snapshot.providers, 'firecrawl scrape': { multiplier: '1', source: 'provider' as const } } };
    expect(() => multiplierForProviderCall(tampered, 'firecrawl', 'scrape')).toThrow('SNAPSHOT_INVALID');
    for (const broken of [null, { multiplier: 3 }, {}]) {
      const value = { ...snapshot, providers: { ...snapshot.providers, 'firecrawl scrape': broken } } as never;
      expect(() => multiplierForProviderCall(value, 'firecrawl', 'scrape')).toThrow('SNAPSHOT_INVALID');
      expect(() => multiplierForCall(value, 'm')).toThrow('SNAPSHOT_INVALID');
    }
  });

  it('a route-only operation needs no model, and an unpriced route blocks the whole snapshot', async () => {
    const client = { from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }) } as unknown as SupabaseClient;
    const snapshot = await readMultiplierSnapshot(client, [], (fallback) => resolveProviderMultipliers(prices, routes.slice(0, 1), fallback, AT));
    expect(snapshot.models).toEqual({});
    await expect(readMultiplierSnapshot(client, [], (fallback) =>
      resolveProviderMultipliers(prices, [{ provider: 'tikhub', route: 'x' }], fallback, AT))).rejects.toThrow('PRICE_UNKNOWN');
  });

  it('sources cannot be mixed between the model and route maps', () => {
    const settings = { creditsPerUsd: '100', defaultMultiplier: '3' };
    expect(() => buildMultiplierSnapshot(settings, { m: { multiplier: '2', source: 'provider' } })).toThrow('SNAPSHOT_INVALID');
    expect(() => buildMultiplierSnapshot(settings, {}, { 'p r': { multiplier: '2', source: 'model' } })).toThrow('SNAPSHOT_INVALID');
    expect(() => buildMultiplierSnapshot(settings, {}, {})).toThrow('SNAPSHOT_INVALID');
  });
});
