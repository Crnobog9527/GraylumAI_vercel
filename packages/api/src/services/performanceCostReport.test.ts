import { describe, expect, it } from 'vitest';
import {
  buildPerformanceCostStats,
  calculateTokenCacheHitRate,
  estimateCacheSavings,
} from './performanceCostReport';

describe('buildPerformanceCostStats', () => {
  it('uses recorded cost rows as the denominator and preserves sub-cent values', () => {
    expect(buildPerformanceCostStats([
      { total_cost_usd: '0.000001' },
      { total_cost_usd: '0.000003' },
    ], 30, 0.0000001)).toEqual({
      totalCost: 0.000004,
      avgCostPerRequest: 0.000002,
      cacheSavings: 0.0000001,
      estimatedMonthly: 0.000004,
    });
  });

  it('handles empty and large reports without pre-rounding', () => {
    expect(buildPerformanceCostStats([], 7, 0).avgCostPerRequest).toBe(0);
    expect(buildPerformanceCostStats([{ total_cost_usd: '1000000.25' }], 30, 0).totalCost).toBe(1000000.25);
  });

  it('does not claim zero savings when cache usage or model pricing is unknown', () => {
    expect(estimateCacheSavings([{ model_used: 'bill2.aggregate', cached_tokens: null }], [])).toBeNull();
    expect(estimateCacheSavings([{ model_used: 'bill2.aggregate', cached_tokens: 100 }], [])).toBeNull();
    expect(estimateCacheSavings([{ model_used: 'model-a', cached_tokens: 100 }], [
      { model_id: 'model-a', input_token_cost: 1000000 },
    ])).toBe(0.00009);
  });
});

describe('calculateTokenCacheHitRate', () => {
  it('reports the cached share of input tokens', () => {
    expect(calculateTokenCacheHitRate([
      { input_tokens: 300, cached_tokens: 100 },
      { input_tokens: 500, cached_tokens: 100 },
    ])).toBe(20);
    expect(calculateTokenCacheHitRate([{ input_tokens: 200, cached_tokens: 0 }])).toBe(0);
    expect(calculateTokenCacheHitRate([])).toBe(0);
  });

  it('returns unknown instead of 0% when any row did not record cache usage', () => {
    expect(calculateTokenCacheHitRate([
      { input_tokens: 300, cached_tokens: 100 },
      { input_tokens: 200, cached_tokens: null },
    ])).toBeNull();
  });
});
