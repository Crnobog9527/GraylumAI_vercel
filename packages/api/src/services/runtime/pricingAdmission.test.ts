/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import { normalizeEndpointPricing, type PricingSnapshot } from '../../shared/modelPricing';
import { configuredReasoning } from '../__tests__/fixtures/runtimeReasoning';
import { admitPricing, PRICE_SNAPSHOT_MAX_AGE_MS, resetPriceRefreshCooldown } from './pricingAdmission';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../models/openRouterCatalog', () => ({ readOpenRouterPricing: vi.fn(() => {
  throw new Error('Tests must inject an offline pricing reader');
}) }));
const NOW = Date.parse('2026-10-02T00:00:00Z');
const MODEL = 'synthetic/model';
const ROUTE = 'synthetic/fp8';
function snapshot(model = MODEL, age = 0, prompt = '0.000002'): PricingSnapshot {
  return {
    model, fetchedAt: new Date(NOW - age).toISOString(), source: 'offline://catalog',
    pricingHash: 'a'.repeat(64),
    endpoints: [normalizeEndpointPricing(ROUTE, 32000, { prompt, completion: '0.000010' })],
  };
}
function row(id = 'primary', price = snapshot()) {
  return {
    id, model_id: price.model, updated_at: '2026-09-01T00:00:00Z',
    config: { ...configuredReasoning(price.model), pricing: price, connectionStatus: 'ok' },
  };
}
type Row = ReturnType<typeof row>;
function quote(id = 'primary', model = MODEL) {
  return { modelId: id, model, providerLimits: {
    providerSlug: ROUTE, contextTokens: 32000,
    promptUsdPerMillion: '2', completionUsdPerMillion: '10', requestUsd: '0',
  } };
}
function database(initial: Row[], options: { latest?: Row | null; write?: 'conflict' | 'error' | (() => 'conflict' | undefined) } = {}) {
  const updates: Array<{ config: Row['config']; updated_at: string }> = [];
  const predicates: Array<[string, unknown]> = [];
  const reread = vi.fn(async () => ({ data: options.latest ?? null, error: null }));
  const selectIds = vi.fn(async (_key: string, ids: string[]) => ({
    data: initial.filter(item => ids.includes(item.id)), error: null,
  }));
  const admin = { from: vi.fn((table: string) => {
    expect(table).toBe('ai_models');
    return {
      select: () => ({ in: selectIds, eq: () => ({ maybeSingle: reread }) }),
      update: (payload: typeof updates[number]) => {
        updates.push(payload);
        const query = {
          eq: (key: string, value: unknown) => { predicates.push([key, value]); return query; },
          select: async () => {
            const outcome = typeof options.write === 'function' ? options.write() : options.write;
            return { data: outcome ? [] : [{ id: 'written' }],
              error: outcome === 'error' ? { message: 'offline write failure' } : null };
          },
        };
        return query;
      },
    };
  }) } as unknown as SupabaseClient;
  return { admin, updates, predicates, reread, selectIds };
}
function offline(fresh = snapshot()) {
  return { now: () => NOW, read: vi.fn(async () => fresh) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { resetPriceRefreshCooldown(); vi.clearAllMocks(); });

describe('admitPricing offline admission', () => {
  it.each([-1000, 0, 1000])('renews only beyond the seven-day boundary (%d ms)', async delta => {
    const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + delta))]);
    const deps = offline();
    await admitPricing(db.admin, [quote()], deps);
    expect(deps.read).toHaveBeenCalledTimes(delta > 0 ? 1 : 0);
  });

  it('preserves reasoning and connection status and conditions its single write on the original version', async () => {
    const original = row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1));
    const db = database([original]);
    await admitPricing(db.admin, [quote()], offline());
    expect(db.updates).toEqual([{ config: { ...original.config, pricing: snapshot() },
      updated_at: new Date(NOW).toISOString() }]);
    expect(db.predicates).toEqual([['id', original.id], ['updated_at', original.updated_at]]);
    expect(db.reread).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('api', 'model_price_snapshot_changed',
      expect.objectContaining({ trigger: 'admission', modelId: original.id, model: MODEL,
        outcome: 'written', changed: false, changes: [], routes: [ROUTE], previousHash: 'a'.repeat(64), pricingHash: 'a'.repeat(64) }));
  });

  it('starts primary and organizer renewals in parallel and deduplicates a repeated model', async () => {
    const a = deferred<PricingSnapshot>(), b = deferred<PricingSnapshot>();
    const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1)),
      row('organizer', snapshot('synthetic/organizer', PRICE_SNAPSHOT_MAX_AGE_MS + 1))]);
    const read = vi.fn((model: string) => model === MODEL ? a.promise : b.promise);
    const pending = admitPricing(db.admin, [quote(), quote('organizer', 'synthetic/organizer'), quote()],
      { read, now: () => NOW });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(db.updates).toHaveLength(0);
    a.resolve(snapshot()); b.resolve(snapshot('synthetic/organizer'));
    await pending;
    expect(db.updates).toHaveLength(2);
    expect(db.selectIds).toHaveBeenCalledWith('id', ['primary', 'organizer']);
  });

  it('two simultaneous admissions read in parallel; one wins CAS and the loser reads its snapshot', async () => {
    const fresh = snapshot(), gate = deferred<PricingSnapshot>();
    let writes = 0;
    const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1))], {
      latest: row('primary', fresh), write: () => ++writes === 1 ? undefined : 'conflict',
    });
    const read = vi.fn(() => gate.promise), deps = { read, now: () => NOW };
    const first = admitPricing(db.admin, [quote()], deps);
    const second = admitPricing(db.admin, [quote()], deps);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    gate.resolve(fresh);
    await Promise.all([first, second]);
    expect(db.updates).toHaveLength(2);
    expect(db.reread).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('api', 'model_price_snapshot_changed',
      expect.objectContaining({ outcome: 'write_conflict', used: 'stored' }));
  });

  it('logs route and field changes after a successful renewal, even when a rise blocks admission', async () => {
    const fresh = snapshot(MODEL, 0, '0.000003');
    fresh.pricingHash = 'b'.repeat(64);
    const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1))]);
    await expect(admitPricing(db.admin, [quote()], offline(fresh))).rejects.toThrow('RUNTIME_PRICE_INCREASED');
    expect(logger.info).toHaveBeenCalledWith('api', 'model_price_snapshot_changed',
      expect.objectContaining({ trigger: 'admission', routes: [ROUTE], changed: true,
        previousHash: 'a'.repeat(64), pricingHash: 'b'.repeat(64),
        changes: [{ tag: ROUTE, change: 'changed', field: 'prompt', before: '2', after: '3' }] }));
  });

  it.each(['conflict', 'error'] as const)('uses a fresh stored winner after CAS %s and never retries the write', async write => {
    const stale = snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1);
    const winner = row('primary', snapshot(MODEL, 0, '0.000003'));
    const db = database([row('primary', stale)], { write, latest: winner });
    await expect(admitPricing(db.admin, [quote()], offline())).rejects.toThrow('RUNTIME_PRICE_INCREASED');
    expect(db.reread).toHaveBeenCalledTimes(1);
    expect(db.updates).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith('api', 'model_price_snapshot_changed',
      expect.objectContaining({ outcome: write === 'error' ? 'write_failed' : 'write_conflict', used: 'stored' }));
  });

  it('uses the fresh unwritten price while preserving an administrator concurrent reasoning edit', async () => {
    const initial = row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1));
    const winner = structuredClone(initial);
    winner.config.reasoning.route = 'other/route';
    winner.config.connectionStatus = 'failed';
    const db = database([initial], { write: 'conflict', latest: winner });
    await admitPricing(db.admin, [quote()], offline());
    expect(winner.config.reasoning.route).toBe('other/route');
    expect(winner.config.connectionStatus).toBe('failed');
    expect(db.updates).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith('api', 'model_price_snapshot_changed',
      expect.objectContaining({ outcome: 'write_conflict', used: 'fresh_unwritten' }));
  });

  it.each(['model', 'catalog', 'route', 'deleted'] as const)('rechecks the latest row after lost CAS: %s', async change => {
    const initial = row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1));
    const latest = structuredClone(initial);
    if (change === 'model') latest.model_id = 'changed/model';
    if (change === 'catalog') latest.config.reasoning.catalog!.model = 'changed/model';
    if (change === 'route') latest.config.reasoning.catalog!.endpoints = [];
    const db = database([initial], { write: 'conflict', latest: change === 'deleted' ? null : latest });
    await expect(admitPricing(db.admin, [quote()], offline())).rejects.toThrow(
      change === 'deleted' ? 'RUNTIME_STAGING_MODEL_DENIED' : 'RUNTIME_PRICE_SNAPSHOT_MISSING');
    expect(db.updates).toHaveLength(1);
  });

  it('blocks failed refreshes for 60 seconds, retries at the boundary and allows a manual fresh snapshot', async () => {
    const initial = row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1));
    const db = database([initial]);
    let now = NOW;
    const read = vi.fn<() => Promise<PricingSnapshot>>()
      .mockRejectedValueOnce(new Error('offline outage')).mockResolvedValue(snapshot());
    const deps = { read, now: () => now };
    await expect(admitPricing(db.admin, [quote()], deps)).rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_STALE');
    now += 59_999;
    await expect(admitPricing(db.admin, [quote()], deps)).rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_STALE');
    expect(read).toHaveBeenCalledTimes(1);
    await admitPricing(database([row()]).admin, [quote()], deps);
    expect(read).toHaveBeenCalledTimes(1);
    now += 1;
    await admitPricing(db.admin, [quote()], deps);
    expect(read).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('api', 'model_price_snapshot_changed',
      expect.objectContaining({ outcome: 'read_failed', previousHash: 'a'.repeat(64) }));
  });

  it('starts the full 60-second cooldown when a slow failed refresh finishes', async () => {
    const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1))]);
    let now = NOW;
    const read = vi.fn<() => Promise<PricingSnapshot>>()
      .mockImplementationOnce(async () => {
        now += 15_000;
        throw new Error('offline 15-second timeout');
      })
      .mockResolvedValue(snapshot());
    const deps = { read, now: () => now };
    await expect(admitPricing(db.admin, [quote()], deps)).rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_STALE');
    now += 59_999;
    await expect(admitPricing(db.admin, [quote()], deps)).rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_STALE');
    expect(read).toHaveBeenCalledTimes(1);
    now += 1;
    await admitPricing(db.admin, [quote()], deps);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['snapshot-model', 'quote-model', 'catalog-model', 'catalog-route', 'price-route', 'unpriceable'] as const)(
    'refuses inconsistent or unavailable snapshot: %s', async change => {
      const initial = row(), selected = quote();
      if (change === 'snapshot-model') initial.config.pricing.model = 'other/model';
      if (change === 'quote-model') selected.model = 'other/model';
      if (change === 'catalog-model') initial.config.reasoning.catalog!.model = 'other/model';
      if (change === 'catalog-route') initial.config.reasoning.catalog!.endpoints = [];
      if (change === 'price-route') initial.config.pricing.endpoints = [];
      if (change === 'unpriceable') initial.config.pricing.endpoints[0]!.admissible = false;
      await expect(admitPricing(database([initial]).admin, [selected], offline()))
        .rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_MISSING');
    });

  it('rejects a missing model before attempting any catalog read', async () => {
    const deps = offline();
    await expect(admitPricing(database([]).admin, [quote()], deps)).rejects.toThrow('RUNTIME_STAGING_MODEL_DENIED');
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('rejects missing pricing and missing provider limits without refreshing', async () => {
    const initial = row();
    Reflect.deleteProperty(initial.config, 'pricing');
    const deps = offline();
    await expect(admitPricing(database([initial]).admin, [quote()], deps))
      .rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_MISSING');
    await expect(admitPricing(database([row()]).admin, [{ modelId: 'primary', model: MODEL }], deps))
      .rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_MISSING');
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('rejects a new base pricing key under D5', async () => {
    const initial = row();
    initial.config.pricing.endpoints[0]!.unknownKeys = ['future_charge'];
    await expect(admitPricing(database([initial]).admin, [quote()], offline()))
      .rejects.toThrow('RUNTIME_PRICE_UNKNOWN_FIELD');
  });

  it('refuses the entire auto selection when one candidate price rises', async () => {
    const candidate = row('candidate', snapshot('synthetic/candidate', 0, '0.000003'));
    await expect(admitPricing(database([row(), candidate]).admin,
      [quote(), quote('candidate', candidate.model_id)], offline())).rejects.toThrow('RUNTIME_PRICE_INCREASED');
  });

  it.each(['prompt', 'completion', 'request'] as const)('rejects and logs an isolated %s increase', async field => {
    const initial = row();
    initial.config.pricing.endpoints[0]!.base[field] = field === 'prompt' ? '3' : field === 'completion' ? '11' : '0.01';
    await expect(admitPricing(database([initial]).admin, [quote()], offline())).rejects.toThrow('RUNTIME_PRICE_INCREASED');
    expect(logger.warn).toHaveBeenCalledWith('api', 'model_price_increased', expect.objectContaining({
      route: ROUTE, increases: [expect.objectContaining({ field })],
    }));
  });

  it('accepts a decrease without modifying the frozen quote', async () => {
    const selected = quote(), frozen = structuredClone(selected);
    const db = database([row('primary', snapshot(MODEL, 0, '0.000001'))]);
    await admitPricing(db.admin, [selected], offline());
    expect(selected).toEqual(frozen);
    expect(db.updates).toHaveLength(0);
  });

  it('prices the window route even when reasoning.route selects a different expensive route', async () => {
    const initial = row();
    initial.config.reasoning.route = 'other/route';
    initial.config.pricing.endpoints.push(normalizeEndpointPricing('other/route', 32000,
      { prompt: '0.000100', completion: '0.000100' }));
    await admitPricing(database([initial]).admin, [quote()], offline());
  });
});
