/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  MAX_RAW_PRICING_BYTES, describeCondition, diffPricing, mergeDuplicateTags, normalizeEndpointPricing, perMillion,
  pricingSnapshot, readPricingSnapshot, type PricingSnapshot,
} from './modelPricing';

// Pricing shapes as read from the public OpenRouter catalog on 2026-10-02 (trimmed).
const luna = {
  prompt: '0.0000001', completion: '0.0000005', web_search: '0.01', input_cache_read: '0.00000001', input_cache_write: '0.000000125', discount: 0,
  overrides: [{ min_prompt_tokens: 272000, prompt: '0.0000002', completion: '0.00000075', input_cache_read: '0.00000002', input_cache_write: '0.00000025' }],
};
const gemini = {
  prompt: '0.00000075', completion: '0.00000375', image: '0.00000075', audio: '0.00000075', input_audio_cache: '0.000000075', web_search: '0.014',
  internal_reasoning: '0.00000375', input_cache_read: '0.000000075', input_cache_write: '0.0000000416666666666667', discount: 0.5,
};
const deepseekPro = {
  prompt: '0.00000132', completion: '0.00000396', input_cache_read: '0.000000044', discount: 0,
  overrides: [
    { utc_days: ['saturday', 'sunday'], prompt: '0.00000066', completion: '0.00000198', input_cache_read: '0.000000022' },
    { utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], utc_start: 1400, utc_end: 0, prompt: '0.00000066' },
  ],
};

describe('perMillion', () => {
  it.each([
    ['0.000002', '2'], ['0.0000025', '2.5'], ['0.0000001', '0.1'], ['0.0000000248', '0.0248'], ['0', '0'], ['1', '1000000'],
    // Gemini's storage fee has more than 12 decimals per million; it rounds up, never down.
    ['0.0000000416666666666667', '0.041666666667'], ['0.0000000000000000001', '0.000000000001'],
  ])('%s per token is %s per million', (input, output) => {
    expect(perMillion(input)).toBe(output);
  });

  it.each(['-0.000001', '1e-7', '0x10', '', '.5', '1.', ' 0.1', '1000', 'NaN'])('rejects %j', input => {
    expect(perMillion(input)).toBeNull();
  });
});

describe('normalizeEndpointPricing', () => {
  it('keeps the OpenRouter structure: base prices, tiers and the raw object', () => {
    const endpoint = normalizeEndpointPricing('openai', 1050000, luna);
    expect(endpoint).toEqual({
      tag: 'openai', contextLength: 1050000, admissible: true, issues: [], discount: 0, unknownKeys: [],
      base: { prompt: '0.1', completion: '0.5', web_search: '0.01', input_cache_read: '0.01', input_cache_write: '0.125' },
      overrides: [{ when: { minPromptTokens: 272000 }, prices: { prompt: '0.2', completion: '0.75', input_cache_read: '0.02', input_cache_write: '0.25' } }],
      raw: luna,
    });
  });

  it('keeps non-text prices in their own unit and the discount as a number', () => {
    const endpoint = normalizeEndpointPricing('google-vertex/global', 1048576, gemini);
    expect(endpoint.admissible).toBe(true);
    expect(endpoint.base).toMatchObject({ input_cache_write: '0.041666666667', internal_reasoning: '3.75', web_search: '0.014', image: '0.00000075' });
    expect(endpoint.discount).toBe(0.5);
  });

  it('reads time-of-day overrides, including one that crosses midnight, and keeps a partial override partial', () => {
    const endpoint = normalizeEndpointPricing('deepseek', 1048576, deepseekPro);
    expect(endpoint.admissible).toBe(true);
    expect(endpoint.overrides[1]).toEqual({ when: { utcDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], utcStart: 1400, utcEnd: 0 },
      prices: { prompt: '0.66' } });
    expect(describeCondition(endpoint.overrides[1]!.when)).toBe('周一、周二、周三、周四、周五，UTC 14:00–00:00（跨午夜）');
    expect(describeCondition({ minPromptTokens: 272000 })).toBe('输入 ≥ 272,000 token');
  });

  it('records an unknown base key without blocking the route; D5 is applied at admission', () => {
    const endpoint = normalizeEndpointPricing('x', null, { prompt: '0.000001', completion: '0.000002', storage_per_hour: '0.1' });
    expect(endpoint).toMatchObject({ admissible: true, unknownKeys: ['storage_per_hour'], base: { prompt: '1', completion: '2' } });
  });

  it.each([
    ['no pricing', undefined, 'PRICING_MISSING'],
    ['no completion price', { prompt: '0.000001' }, 'BASE_PRICE_MISSING'],
    ['a negative price', { prompt: '-1', completion: '-1' }, 'PRICE_INVALID'],
    ['a numeric price', { prompt: 0.000001, completion: '0.000002' }, 'PRICE_INVALID'],
    ['a string discount', { prompt: '0', completion: '0', discount: '0.5' }, 'DISCOUNT_INVALID'],
    ['an unknown key in an override', { ...luna, overrides: [{ min_prompt_tokens: 1, region: 'us', prompt: '0.1' }] }, 'OVERRIDE_KEY_UNKNOWN'],
    ['an override without a condition', { ...luna, overrides: [{ prompt: '0.0000002' }] }, 'OVERRIDE_CONDITION_MISSING'],
    ['an hour past 23', { ...luna, overrides: [{ utc_start: 2400, prompt: '0.0000002' }] }, 'OVERRIDE_CONDITION_INVALID'],
    ['minutes past 59', { ...luna, overrides: [{ utc_end: 1360, prompt: '0.0000002' }] }, 'OVERRIDE_CONDITION_INVALID'],
    ['a capitalised day', { ...luna, overrides: [{ utc_days: ['Monday'], prompt: '0.0000002' }] }, 'OVERRIDE_CONDITION_INVALID'],
    ['a non-array override list', { ...luna, overrides: {} }, 'OVERRIDE_INVALID'],
    ['too many overrides', { ...luna, overrides: Array.from({ length: 17 }, () => luna.overrides[0]) }, 'TOO_MANY_OVERRIDES'],
    ['an oversized object', { prompt: '0', completion: '0', note: 'x'.repeat(MAX_RAW_PRICING_BYTES) }, 'RAW_TOO_LARGE'],
  ])('marks a route with %s as not admissible', (_name, pricing, issue) => {
    const endpoint = normalizeEndpointPricing('x', null, pricing);
    expect(endpoint.admissible).toBe(false);
    expect(endpoint.issues).toContain(issue);
    expect(pricingSnapshot.shape.endpoints.element.safeParse(endpoint).success).toBe(true);
  });
});

describe('mergeDuplicateTags', () => {
  it('marks a tag listed twice with different prices as not unique', () => {
    const merged = mergeDuplicateTags([
      normalizeEndpointPricing('baseten/fp8', 1048576, { prompt: '0.0000003', completion: '0.0000012' }),
      normalizeEndpointPricing('baseten/fp8', 1048576, { prompt: '0.0000004', completion: '0.0000012' }),
      normalizeEndpointPricing('wafer', 1048576, { prompt: '0.00000005', completion: '0.0000006' }),
    ]);
    expect(merged.map(endpoint => [endpoint.tag, endpoint.admissible, endpoint.issues])).toEqual([
      ['baseten/fp8', false, ['PRICE_NOT_UNIQUE']], ['wafer', true, []],
    ]);
  });
});

describe('snapshot', () => {
  const snapshot = (endpoints: PricingSnapshot['endpoints']): PricingSnapshot => ({
    fetchedAt: '2026-10-02T06:56:00.000Z', model: 'openai/gpt-6-luna', source: 'openrouter:/api/v1/models/openai/gpt-6-luna/endpoints',
    pricingHash: 'a'.repeat(64), endpoints,
  });

  it('reads a valid stored snapshot and nothing else', () => {
    const value = snapshot([normalizeEndpointPricing('openai', 1050000, luna)]);
    expect(readPricingSnapshot({ pricing: value, reasoning: {} })).toEqual(value);
    expect(readPricingSnapshot({ pricing: { ...value, extra: 1 } })).toBeNull();
    expect(readPricingSnapshot({ pricing: { ...value, endpoints: [{ ...value.endpoints[0], base: { prompt: 'free' } }] } })).toBeNull();
    expect(readPricingSnapshot(null)).toBeNull();
  });

  it('lists added, removed and changed fields', () => {
    const before = snapshot([normalizeEndpointPricing('openai', 1050000, luna), normalizeEndpointPricing('azure', 1050000, luna)]);
    const raised = { ...luna, overrides: [{ ...luna.overrides[0], input_cache_write: '0.0000003' }] };
    const after = snapshot([normalizeEndpointPricing('openai', 1050000, raised), normalizeEndpointPricing('azure/us', 1050000, luna)]);
    expect(diffPricing(before, after)).toEqual([
      { tag: 'azure', change: 'removed' },
      { tag: 'openai', change: 'changed', field: 'overrides[0].input_cache_write', before: '0.25', after: '0.3' },
      { tag: 'azure/us', change: 'added' },
    ]);
    expect(diffPricing(null, after)).toEqual([]);
  });
});
