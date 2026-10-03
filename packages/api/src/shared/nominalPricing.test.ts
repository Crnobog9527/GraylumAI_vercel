/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { normalizeEndpointPricing } from './modelPricing';
import { deriveFrozenPrices, deriveListPrices } from './modelPriceBound';
import { nominalPricing, nominalCost, nominalActualFallback, nominalCostBreakdown, selectNominalPrices, validateNominalBound } from './nominalPricing';
const hash = 'a'.repeat(64);
const endpoint = normalizeEndpointPricing('provider/exact', 1_000_000, {
  prompt: '0.000002', completion: '0.00001', input_cache_write: '0.0000025', discount: 0.5,
  overrides: [
    { min_prompt_tokens: 100, prompt: '0.000004' },
    { utc_start: 0, utc_end: 1200, prompt: '0.000001', completion: '0.000015' },
    { min_prompt_tokens: 200, utc_days: ['monday'], prompt: '0.000007' },
  ],
});
const table = nominalPricing.parse(deriveListPrices(endpoint, hash, 'anthropic/model'));
describe('nominal pricing frozen contract', () => {
  it('retains complete tiers, inherits base and excludes discount from charging', () => {
    expect(table.tiers).toEqual([
      { minPromptTokens: 0, prompt: '2', completion: '10', request: '0', cacheWrite: '2.5' },
      { minPromptTokens: 100, prompt: '4', completion: '10', request: '0', cacheWrite: '6.5' },
    ]);
    expect(JSON.stringify(table)).not.toMatch(/discount/);
  });
  it.each([[99, '2'], [100, '4'], [101, '4'], [199, '4'], [200, '7']])('selects threshold at P=%i', (p, prompt) => {
    expect(selectNominalPrices(table, p as number)).toMatchObject({ prompt, completion: '15' });
  });
  it('uses full prompt tokens despite cache and ignores actual cost', () => {
    expect(nominalCost(table, { promptTokens: 50, completionTokens: 20 })).toBe('0.0004');
  });
  it('does not count reasoning twice; requires R only for distinct price', () => {
    const distinct = { ...table, timeOfDay: [], tiers: [{ ...table.tiers[0]!, internalReasoning: '30' }] };
    expect(nominalCost(distinct, { promptTokens: 50, completionTokens: 20, reasoningTokens: 5 })).toBe('0.0004');
    expect(nominalCost(distinct, { promptTokens: 50, completionTokens: 20 })).toBeNull();
    expect(nominalCost(table, { promptTokens: 50, completionTokens: 20 })).not.toBeNull();
  });
  it('retains 18-place cost precision and adds request without million divisor', () => {
    const tiny = { ...table, timeOfDay: [], tiers: [{ minPromptTokens: 0, prompt: '0.000000000001', completion: '0', request: '0.01' }] };
    expect(nominalCost(tiny, { promptTokens: 1, completionTokens: 0 })).toBe('0.010000000000000001');
  });
  it('distinguishes missing counts and invalid or contradictory counts', () => {
    expect(nominalCost(table, {})).toBeNull();
    for (const count of [-1, 0.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => nominalCost(table, { promptTokens: count, completionTokens: 0 })).toThrow('EVIDENCE_CONFLICT');
    }
    expect(() => nominalCost(table, { promptTokens: 1, completionTokens: 2, reasoningTokens: 3 })).toThrow('EVIDENCE_CONFLICT');
  });
  it('caps fallback at U without rounding', () => {
    expect(nominalActualFallback('0.123456789012', '0.1')).toBe('0.1');
    expect(nominalActualFallback('0.000000000001', '0.1')).toBe('0.000000000001');
    expect(() => nominalActualFallback('-1', '0.1')).toThrow();
  });
  it('bounds only reachable tiers, preserving P>T price selection', () => {
    const prices = deriveFrozenPrices('anthropic/model', endpoint, 99);
    if (typeof prices === 'string') throw new Error(prices);
    const bound = { ...prices, pricingHash: hash, endpointTag: endpoint.tag, promptTokensUpper: 99 };
    expect(() => validateNominalBound(table, bound)).not.toThrow();
    expect(() => validateNominalBound(table, { ...bound, promptTokensUpper: 100 })).toThrow('BOUND_CONFLICT');
    expect(() => validateNominalBound(table, { ...bound, pricingHash: 'b'.repeat(64) })).toThrow('IDENTITY_CONFLICT');
    expect(nominalCost(table, { promptTokens: 200, completionTokens: 0 })).toBe('0.0014');
  });
  it('rejects unknown fields, excessive or duplicate tiers, malformed price and unknown snapshot fields', () => {
    expect(nominalPricing.safeParse({ ...table, discount: 0 }).success).toBe(false);
    expect(nominalPricing.safeParse({ ...table, tiers: [table.tiers[0], table.tiers[0]] }).success).toBe(false);
    expect(nominalPricing.safeParse({ ...table, timeOfDay: Array(16).fill(table.timeOfDay[0]) }).success).toBe(false);
    expect(nominalPricing.safeParse({ ...table, tiers: [{ ...table.tiers[0], prompt: '1e-9' }] }).success).toBe(false);
    expect(deriveListPrices({ ...endpoint, unknownKeys: ['unknown_fee'] }, hash, 'anthropic/model')).toBe('UNKNOWN_PRICE_FIELD');
  });
});

describe('nominal minus actual audit breakdown', () => {
  const snapshot = normalizeEndpointPricing('anthropic', 200000, {
    prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002', input_cache_write: '0.0000025',
  });
  const audit = nominalPricing.parse(deriveListPrices(snapshot, hash, 'anthropic/model'));
  it('reproduces read savings and write premium examples without changing nominal charge', () => {
    expect(nominalCostBreakdown(audit, { promptTokens: 48000, cachedTokens: 40000, cacheCreationTokens: 0 }, '0.106', '0.034'))
      .toEqual({ platformDifferenceUsd: '0.072', cacheReadSavingsUsd: '0.072', cacheWritePremiumUsd: '0', otherDifferenceUsd: '0' });
    expect(nominalCostBreakdown(audit, { promptTokens: 48000, cachedTokens: 0, cacheCreationTokens: 40000 }, '0.106', '0.126'))
      .toEqual({ platformDifferenceUsd: '-0.02', cacheReadSavingsUsd: '0', cacheWritePremiumUsd: '0.02', otherDifferenceUsd: '0' });
  });
  it('preserves signed discount/other remainder and 18 decimal places', () => {
    const tiny = { ...audit, tiers: [{ ...audit.tiers[0]!, prompt: '0.000000000002', cacheRead: '0.000000000001' }] };
    expect(nominalCostBreakdown(tiny, { promptTokens: 1, cachedTokens: 1, cacheCreationTokens: 0 },
      '0.000000000000000002', '0.000000000000000003'))
      .toEqual({ platformDifferenceUsd: '-0.000000000000000001', cacheReadSavingsUsd: '0.000000000000000001',
        cacheWritePremiumUsd: '0', otherDifferenceUsd: '-0.000000000000000002' });
  });
  it('adds Gemini storage to ordinary prompt price, including inherited tier prices', () => {
    const google = normalizeEndpointPricing('google', 1000000, {
      prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002', input_cache_write: '0.000003',
      overrides: [{ min_prompt_tokens: 100, prompt: '0.000004' }],
    });
    const derived = nominalPricing.parse(deriveListPrices(google, hash, 'google/model'));
    expect(derived.tiers.map(tier => tier.cacheWrite)).toEqual(['5', '7']);
    expect(nominalCostBreakdown(derived, { promptTokens: 100, cachedTokens: 0, cacheCreationTokens: 100 }, '0.0004', '0.0007'))
      .toMatchObject({ cacheWritePremiumUsd: '0.0003', platformDifferenceUsd: '-0.0003', otherDifferenceUsd: '0' });
  });
  it('keeps incomplete prices or counts unknown, with independently known components available', () => {
    const missing = { ...audit, tiers: [{ minPromptTokens: 0, prompt: '2', completion: '10', request: '0' }] };
    expect(nominalCostBreakdown(missing, { promptTokens: 10, cachedTokens: 0, cacheCreationTokens: 0 }, '0.1', '0.2'))
      .toEqual({ platformDifferenceUsd: '-0.1', cacheReadSavingsUsd: null, cacheWritePremiumUsd: null, otherDifferenceUsd: null });
    expect(nominalCostBreakdown(audit, { promptTokens: 100, cachedTokens: 10 }, '0.1', '0.1'))
      .toMatchObject({ cacheReadSavingsUsd: '0.000018', cacheWritePremiumUsd: null, otherDifferenceUsd: null });
  });
  it('does not misattribute invalid cache partitions or actual fallback to cache gains', () => {
    for (const usage of [{ promptTokens: 100, cachedTokens: 80, cacheCreationTokens: 30 }, { cachedTokens: 80 }]) {
      expect(nominalCostBreakdown(audit, usage, '0.1', '0.2')).toMatchObject({
        cacheReadSavingsUsd: null, cacheWritePremiumUsd: null, otherDifferenceUsd: null,
      });
    }
    expect(nominalCostBreakdown(audit, { promptTokens: 100, cachedTokens: 50, cacheCreationTokens: 50 }, '0.1', '0.2', 'actual_fallback'))
      .toEqual({ platformDifferenceUsd: '-0.1', cacheReadSavingsUsd: null, cacheWritePremiumUsd: null, otherDifferenceUsd: null });
  });
  it('time pricing picks applicable maxima and leaves time differences in other', () => {
    const timed = { ...audit, timeOfDay: [{ minPromptTokens: 100, prompt: '3', completion: '10', request: '0',
      cacheRead: '0.4', cacheWrite: '4' }] };
    expect(selectNominalPrices(timed, 99)).toMatchObject({ prompt: '2', cacheRead: '0.2', cacheWrite: '2.5' });
    expect(selectNominalPrices(timed, 100)).toMatchObject({ prompt: '3', cacheRead: '0.4', cacheWrite: '4' });
    expect(nominalCostBreakdown(timed, { promptTokens: 100, cachedTokens: 50, cacheCreationTokens: 50 }, '0.0003', '0.0002'))
      .toEqual({ platformDifferenceUsd: '0.0001', cacheReadSavingsUsd: '0.00013', cacheWritePremiumUsd: '0.00005',
        otherDifferenceUsd: '0.00002' });
  });
});
