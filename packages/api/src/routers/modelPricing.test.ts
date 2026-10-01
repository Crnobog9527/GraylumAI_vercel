/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { modelPricingRouter } from './modelPricing';

const MODEL = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-02T00:00:00+00:00';
type Row = { id: string; name: string; model_id: string; is_active: string; price_multiplier: unknown; updated_at: string };

function harness(role: 'admin' | 'user' | 'anonymous', options: {
  settings?: { data: unknown; error: unknown };
  listError?: unknown;
  rows?: Row[];
  readBack?: unknown;
} = {}) {
  const rows: Row[] = options.rows ?? [
    { id: MODEL, name: 'Sonnet', model_id: 'vendor/sonnet', is_active: 'true', price_multiplier: null, updated_at: STAMP },
  ];
  const updates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const settingWrites: Array<{ key: string; value: string }> = [];
  let providerRow: { value: string } | null = null;
  const db = { from(table: string) {
    if (table === 'profiles') return { select() { return this; }, eq() { return this; },
      single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0, nickname: 'S', email: 's@example.test' }, error: null }) };
    if (table === 'system_settings') return {
      select() {
        return {
          in: async () => options.settings ?? { data: [], error: null },
          eq: () => ({ maybeSingle: async () => ({ data: providerRow, error: null }) }),
        };
      },
      upsert: async (row: { key: string; value: string }) => { settingWrites.push(row); providerRow = { value: row.value }; return { error: null }; },
    };
    if (table !== 'ai_models') throw new Error(table);
    return {
      select() { return { order: async () => options.listError ? { data: null, error: options.listError } : { data: rows, error: null } }; },
      update(patch: Record<string, unknown>) {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq(field: string, value: unknown) { filters[field] = value; return chain; },
          select: async () => {
            updates.push({ patch, filters });
            const row = rows.find((r) => r.id === filters.id && r.updated_at === filters.updated_at);
            if (!row) return { data: [], error: null };
            row.price_multiplier = 'readBack' in options ? options.readBack : patch.price_multiplier;
            row.updated_at = String(patch.updated_at);
            return { data: [{ id: row.id, price_multiplier: row.price_multiplier, updated_at: row.updated_at }], error: null };
          },
        };
        return chain;
      },
    };
  } };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: 'actor', email: 's@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: modelPricingRouter.createCaller(ctx), rows, updates, settingWrites };
}

describe('model multiplier admin endpoints', () => {
  it('shows inherited, overridden and invalid values separately', async () => {
    const f = harness('admin', {
      settings: { data: [{ key: 'billing_token_price_multiplier', value: '3' }], error: null },
      rows: [
        { id: 'a', name: 'A', model_id: 'v/a', is_active: 'true', price_multiplier: null, updated_at: STAMP },
        { id: 'b', name: 'B', model_id: 'v/b', is_active: 'false', price_multiplier: 2.5, updated_at: STAMP },
        { id: 'c', name: 'C', model_id: 'v/c', is_active: 'true', price_multiplier: 0, updated_at: STAMP },
      ],
    });
    const view = await f.caller.getMultipliers();
    expect(view.available).toBe(true);
    expect(view.site?.defaultMultiplier).toBe('3');
    expect(view.models.map((m) => [m.id, m.override, m.effective, m.source])).toEqual([
      ['a', null, '3', 'global'], ['b', '2.5', '2.5', 'model'], ['c', null, null, 'invalid'],
    ]);
  });

  it('a missing column or failed read disables editing instead of pretending to inherit', async () => {
    const f = harness('admin', { listError: { code: '42703' } });
    expect(await f.caller.getMultipliers()).toMatchObject({ available: false, models: [] });
  });

  it('global settings that cannot be read show no effective inherited value', async () => {
    const f = harness('admin', { settings: { data: null, error: { code: 'PGRST' } } });
    const view = await f.caller.getMultipliers();
    expect(view.site).toBeNull();
    expect(view.models[0]).toMatchObject({ source: 'global', effective: null });
  });

  it('saves a canonical override, reads it back and clears it to NULL', async () => {
    const f = harness('admin');
    const saved = await f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: '2.50', expectedUpdatedAt: STAMP });
    expect(saved.priceMultiplier).toBe('2.5');
    expect(f.updates[0]).toMatchObject({ patch: { price_multiplier: '2.5' }, filters: { id: MODEL, updated_at: STAMP } });
    const cleared = await f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: '', expectedUpdatedAt: saved.updatedAt });
    expect(cleared.priceMultiplier).toBeNull();
    expect(f.updates[1]?.patch.price_multiplier).toBeNull();
  });

  it.each(['0', '0.99', '20.01', '1.234', '-1', 'abc', '3e0'])('rejects %s before any write', async (value) => {
    const f = harness('admin');
    await expect(f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: value, expectedUpdatedAt: STAMP }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.updates).toEqual([]);
  });

  it('a stale updated_at is a conflict, not an overwrite', async () => {
    const f = harness('admin');
    await expect(f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: '2', expectedUpdatedAt: '2026-01-01T00:00:00+00:00' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows[0]?.price_multiplier).toBeNull();
  });

  it('a read-back that differs from what was saved fails', async () => {
    const f = harness('admin', { readBack: 2.49 });
    await expect(f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: '2.5', expectedUpdatedAt: STAMP }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it.each(['user', 'anonymous'] as const)('denies %s for read and write', async (role) => {
    const f = harness(role);
    for (const call of [() => f.caller.getMultipliers(),
      () => f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: '2', expectedUpdatedAt: STAMP })]) {
      await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    }
    expect(f.updates).toEqual([]);
  });

  const prices = { version: 1, entries: [{
    provider: 'parallel', route: 'search/basic', appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'request',
    unitsPerPrice: '1000', price: '5', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
    pricingBasis: 'list-price',
    sourceUrl: 'https://docs.parallel.ai/getting-started/pricing', evidenceHash: 'b'.repeat(64),
    verifiedAt: '2026-10-01T00:00:00Z', validUntil: null, chargeCondition: 'successful search', includedInReceipt: false,
    priceMultiplier: '2',
  }] };

  it('admin saves third-party prices through the dedicated endpoint and reads them back', async () => {
    const f = harness('admin');
    expect(await f.caller.getProviderPrices()).toEqual({ config: { version: 1, entries: [] }, source: 'absent', hash: null });
    const saved = await f.caller.setProviderPrices({ expectedHash: null, config: prices });
    expect(saved).toMatchObject({ config: prices, source: 'configured', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(f.settingWrites.map((w) => w.key)).toEqual(['billing_provider_prices']);
    await expect(f.caller.setProviderPrices({ expectedHash: null, config: prices })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.settingWrites).toHaveLength(1);
  });

  it('invalid third-party prices are a bad request and are not written', async () => {
    const f = harness('admin');
    await expect(f.caller.setProviderPrices({ expectedHash: null, config: { ...prices, entries: [{ ...prices.entries[0], apiKey: 'sk' }] } }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.settingWrites).toEqual([]);
  });

  it.each(['user', 'anonymous'] as const)('denies %s third-party price access', async (role) => {
    const f = harness(role);
    await expect(f.caller.getProviderPrices()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    await expect(f.caller.setProviderPrices({ expectedHash: null, config: prices }))
      .rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    expect(f.settingWrites).toEqual([]);
  });

  it('rejects unknown fields such as a client-supplied effective multiplier', async () => {
    const f = harness('admin');
    await expect(f.caller.setMultiplier({ modelId: MODEL, priceMultiplier: '2', expectedUpdatedAt: STAMP, effective: '9' } as never))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.updates).toEqual([]);
  });
});
