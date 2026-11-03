/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// What a compare start still checks on the turn path: the live rules and the quote the user was shown. Pricing the columns and
// the budget are turn/compareQuote.test.ts; the old group admission (fusion_group_admit) went with the BILL2 compare.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = vi.hoisted(() => ({ compare: {} as Record<string, unknown>, entitlements: {} as Record<string, unknown> }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()),
  readFusionSettings: async () => ({ version: 1, review: {}, compare: state.compare }) }));
vi.mock('../membershipEntitlements', async original => ({ ...(await original<typeof import('../membershipEntitlements')>()),
  readMembershipEntitlements: async () => state.entitlements, assertFusionEntitlement: () => undefined }));
import { assertCompareAllowed, assertQuoteCovers } from './compareAdmission';

const models = [id(1), id(2), id(3)];
const admin = {} as unknown as SupabaseClient;

beforeEach(() => {
  state.compare = { enabled: true, allowedModelIds: models, defaultModelIds: models.slice(0, 2), minModels: 2, answerOutputTokens: 4096,
    maxBudgetUsd: '2', dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } };
  state.entitlements = { allowFusionCompare: true, fusionCompareMaxModels: 4 };
});

describe('compare live rules (FUSION-COMPARE §3.3)', () => {
  const run = (modelIds: string[]) => assertCompareAllowed(admin, id(50), modelIds);
  it('allows an allowed set within [minModels, D3]', async () => {
    await expect(run(models.slice(0, 2))).resolves.toMatchObject({ minModels: 2 });
    await expect(run(models)).resolves.toBeDefined();
  });
  it.each([
    ['the switch is off', () => { state.compare.enabled = false; }, models, 'FUSION_COMPARE_DISABLED'],
    ['the plan forbids it', () => { state.entitlements.allowFusionCompare = false; }, models, 'FUSION_COMPARE_FORBIDDEN'],
    ['fewer than the administrator minimum', () => { state.compare.minModels = 3; }, models.slice(0, 2), 'FUSION_COMPARE_TOO_FEW'],
    ['fewer than two', () => undefined, models.slice(0, 1), 'FUSION_COMPARE_TOO_FEW'],
    ['more than D3', () => { state.entitlements.fusionCompareMaxModels = 2; }, models, 'FUSION_COMPARE_TOO_MANY'],
    ['a duplicate', () => undefined, [models[0]!, models[0]!], 'FUSION_COMPARE_MODEL_NOT_ALLOWED'],
    ['a model outside the allowlist', () => undefined, [models[0]!, id(99)], 'FUSION_COMPARE_MODEL_NOT_ALLOWED'],
  ])('refuses when %s', async (_name, setup, chosen, code) => {
    (setup as () => void)();
    await expect(run(chosen as string[])).rejects.toThrow(code as string);
  });
});

describe('quote coverage (what the user was shown)', () => {
  const columns = [{ index: 0, modelId: id(1), upperCredits: 10, upperUsd: '0.01' }, { index: 1, modelId: id(2), upperCredits: 10, upperUsd: '0.01' }];
  const quote = { credits: 20, columns: [{ modelId: id(1), credits: 10, usd: '0.01' }, { modelId: id(2), credits: 10, usd: '0.01' }] };
  it('accepts a quote that covers every column, with or without model ids', () => {
    expect(() => assertQuoteCovers(columns, quote)).not.toThrow();
    expect(() => assertQuoteCovers(columns, { credits: 25, columns: quote.columns.map(({ credits, usd }) => ({ credits: credits + 1, usd })) })).not.toThrow();
  });
  it.each([
    ['fewer columns', { ...quote, columns: quote.columns.slice(0, 1) }],
    ['more columns', { ...quote, columns: [...quote.columns, quote.columns[0]!] }],
    ['a lower total', { ...quote, credits: 19 }],
    ['a lower column cap', { ...quote, columns: [{ ...quote.columns[0]!, credits: 9 }, quote.columns[1]!] }],
    ['a lower column cost', { ...quote, columns: [{ ...quote.columns[0]!, usd: '0.009' }, quote.columns[1]!] }],
    ['another model order', { ...quote, columns: [quote.columns[1]!, quote.columns[0]!] }],
  ])('refuses %s', (_name, shownQuote) => {
    expect(() => assertQuoteCovers(columns, shownQuote)).toThrow('FUSION_COMPARE_PRICE_CHANGED');
  });
});
