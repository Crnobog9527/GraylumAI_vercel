/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, expect, it, vi } from 'vitest';
import { normalizeEndpointPricing, type PricingSnapshot } from '../../shared/modelPricing';
import { configuredReasoning } from '../__tests__/fixtures/runtimeReasoning';
import { PRICE_SNAPSHOT_MAX_AGE_MS, resetPriceRefreshCooldown } from './pricingAdmission';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../models/openRouterCatalog', () => ({ readOpenRouterPricing: vi.fn(() => {
  throw new Error('Tests must inject an offline pricing reader');
}) }));
import { freezeStagingPaygPricing, deriveProductionPaygPricing } from './paygPricing';
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
beforeEach(() => { resetPriceRefreshCooldown(); vi.clearAllMocks(); });

const template = {
  version: 'v1', policyId: 'synthetic', profileVersion: 'v1', evidenceVersion: 'v1',
  templateTokens: 1, marginTokens: 1, admissionPath: 'fixture' as const,
  maxBytes: 16000, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16000,
  purposes: ['ordinary'], expiresAt: '2099-01-01T00:00:00Z',
};
it('staging derives nominal from the exact checked renewed snapshot without changing window rates', async () => {
  const fresh = { ...snapshot(), pricingHash: 'b'.repeat(64) };
  const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1))]);
  const original = { ...quote(), payg: template };
  const deps = offline(fresh);
  const [frozen] = await freezeStagingPaygPricing(db.admin, [original], deps);
  expect(frozen!.providerLimits).toEqual(original.providerLimits);
  expect(frozen!.payg.nominalPricing).toMatchObject({ pricingHash: fresh.pricingHash,
    endpointTag: ROUTE, tiers: [{ minPromptTokens: 0, prompt: '2', completion: '10', request: '0' }] });
  expect(frozen!.payg.pricingHash).toBe(fresh.pricingHash);
  expect(original.payg).not.toHaveProperty('nominalPricing');
  expect(deps.read).toHaveBeenCalledTimes(1);
  expect(db.selectIds).toHaveBeenCalledTimes(1);
});
it.each(['error', 'conflict'] as const)('production refuses %s when stored snapshot is still stale', async write => {
  const stale = row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1));
  const db = database([stale], { write, latest: stale });
  await expect(deriveProductionPaygPricing(db.admin, quote(), 100, offline()))
    .rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_STALE');
});
it('production uses a fresh concurrent writer snapshot, not the losing network response', async () => {
  const latest = { ...snapshot(MODEL, 0, '0.000003'), pricingHash: 'c'.repeat(64) };
  const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1))],
    { write: 'conflict', latest: row('primary', latest) });
  const result = await deriveProductionPaygPricing(db.admin, quote(), 100, offline());
  expect(result.pricingHash).toBe(latest.pricingHash);
  expect(result.providerLimits.promptUsdPerMillion).toBe('3');
  expect(result.nominalPricing.pricingHash).toBe(latest.pricingHash);
  expect(result.nominalPricing.tiers[0]!.prompt).toBe('3');
});
it('production accepts a persisted renewal with higher prices and derives for the current T', async () => {
  const fresh = { ...snapshot(MODEL, 0, '0.000004'), pricingHash: 'b'.repeat(64) };
  fresh.endpoints[0]!.overrides = [{ when: { minPromptTokens: 1000 }, prices: { prompt: '40' } }];
  const db = database([row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1))]);
  const result = await deriveProductionPaygPricing(db.admin, quote(), 100, offline(fresh));
  expect(result.providerLimits.promptUsdPerMillion).toBe('4');
  expect(result.nominalPricing.tiers[1]!.prompt).toBe('40');
  expect(db.updates).toHaveLength(1);
});
it('staging retains its existing fresh-unwritten fallback', async () => {
  const stale = row('primary', snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1));
  const db = database([stale], { write: 'error', latest: stale });
  const [result] = await freezeStagingPaygPricing(db.admin, [{ ...quote(), payg: template }], offline());
  expect(result!.payg.pricingHash).toBe(snapshot().pricingHash);
});
it('unknown price fields reject production and staging before a quote is returned', async () => {
  const unknown = snapshot();
  unknown.endpoints[0]!.unknownKeys = ['future_fee'];
  const db = database([row('primary', unknown)]);
  await expect(deriveProductionPaygPricing(db.admin, quote(), 100, offline())).rejects.toThrow('RUNTIME_PRICE_UNKNOWN_FIELD');
  await expect(freezeStagingPaygPricing(db.admin, [{ ...quote(), payg: template }], offline()))
    .rejects.toThrow('RUNTIME_PRICE_UNKNOWN_FIELD');
});
it('production refuses a stale network snapshot even when its write succeeds', async () => {
  const old = snapshot(MODEL, PRICE_SNAPSHOT_MAX_AGE_MS + 1);
  const db = database([row('primary', old)]);
  await expect(deriveProductionPaygPricing(db.admin, quote(), 100, offline(old)))
    .rejects.toThrow('RUNTIME_PRICE_SNAPSHOT_STALE');
});
