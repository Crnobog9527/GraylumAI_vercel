/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { deriveFrozenPrices, priceIncreases, type FrozenPrices } from './modelPriceBound';
import { normalizeEndpointPricing } from './modelPricing';

const derive = (raw: Record<string, unknown>, tokens = 1050000, model = 'openai/gpt-6-luna') =>
  deriveFrozenPrices(model, normalizeEndpointPricing('synthetic', tokens, raw), tokens);
const base = { prompt: '0.0000001', completion: '0.0000005', input_cache_write: '0.000000125' };
const luna = { ...base, overrides: [{ min_prompt_tokens: 272000,
  prompt: '0.0000002', completion: '0.00000075', input_cache_write: '0.00000025' }] };
const prices = (prompt: string, completion: string, request = '0'): FrozenPrices => ({
  promptUsdPerMillion: prompt, completionUsdPerMillion: completion, requestUsd: request,
  explain: { prompt: '', completion: '' },
});

describe('deriveFrozenPrices', () => {
  it.each([[271999, '0.125', '0.5'], [272000, '0.25', '0.75']] as const)(
    'applies the Luna threshold at T=%s', (tokens, prompt, completion) => {
      expect(derive(luna, tokens)).toMatchObject({ ...prices(prompt, completion),
        explain: expect.any(Object), cacheWriteUsdPerMillion: prompt });
    });

  it.each([[31999, '0.1'], [32000, '0.2'], [255999, '0.2'], [256000, '0.4']] as const)(
    'includes every applicable Qwen tier at T=%s', (tokens, prompt) => {
      expect(derive({ prompt: '0.0000001', completion: '0.0000005', overrides: [
        { min_prompt_tokens: 32000, prompt: '0.0000002' },
        { min_prompt_tokens: 256000, prompt: '0.0000004' },
      ] }, tokens, 'qwen/qwen3.7-flash')).toMatchObject({ promptUsdPerMillion: prompt, completionUsdPerMillion: '0.5' });
    });

  it('inherits missing override prices including cache write and takes the highest time price across midnight', () => {
    expect(derive({ ...base, request: '0.01', overrides: [
      { utc_start: 1400, utc_end: 0, prompt: '0.0000002', request: '0.02' },
      { utc_days: ['saturday'], completion: '0.00000075' },
    ] })).toMatchObject({ promptUsdPerMillion: '0.325', completionUsdPerMillion: '0.75',
      cacheWriteUsdPerMillion: '0.325', requestUsd: '0.02' });
  });

  it('adds storage fees separately in each layer instead of mixing maxima from different layers', () => {
    expect(derive({ prompt: '0.000002', completion: '0.00000375', input_cache_write: '0.000001',
      overrides: [{ min_prompt_tokens: 10, prompt: '0.000001', input_cache_write: '0.0000025' }],
    }, 100, 'google/gemini-3.8-flash')).toMatchObject({ promptUsdPerMillion: '3.5', cacheWriteUsdPerMillion: '3.5' });
  });

  it('uses the Anthropic total write price, ignores 1h cache and other non-text costs', () => {
    expect(derive({ prompt: '0.000002', completion: '0.00001', input_cache_write: '0.0000025',
      input_cache_write_1h: '0.000004', web_search: '99', image: '99', discount: 0.5,
    }, 1000000, 'anthropic/claude-sonnet-5.5')).toMatchObject({
      promptUsdPerMillion: '2.5', completionUsdPerMillion: '10', cacheWriteUsdPerMillion: '2.5', requestUsd: '0',
    });
  });

  it('uses internal reasoning when higher and adds a below-input write fee for non-Google models', () => {
    expect(derive({ prompt: '0.000002', completion: '0.000003', input_cache_write: '0.0000005',
      internal_reasoning: '0.000004' })).toMatchObject({ promptUsdPerMillion: '2.5', completionUsdPerMillion: '4' });
  });

  it('omits cache write metadata when absent', () => {
    expect(derive({ prompt: '0.000001', completion: '0.000002' })).not.toHaveProperty('cacheWriteUsdPerMillion');
  });

  it('refuses unknown base fields under D5 and malformed overrides', () => {
    expect(derive({ ...base, storage_per_hour: '0.1' })).toBe('UNKNOWN_PRICE_FIELD');
    expect(derive({ ...base, overrides: [{ min_prompt_tokens: 10, region: 'us' }] })).toBe('NOT_ADMISSIBLE');
  });

  it.each([
    ['anthropic/claude-sonnet-5.5', { prompt: '0.000002', completion: '0.00001', input_cache_write: '0.0000025' }, '2.5', '10', []],
    ['openai/gpt-6-luna', luna, '0.25', '0.75', []],
    ['google/gemini-3.8-flash', { prompt: '0.00000075', completion: '0.00000375',
      input_cache_write: '0.0000000416666666666667' }, '0.75', '3.75',
    [{ field: 'prompt', frozen: '0.75', current: '0.791666666667' }]],
  ])('compares the provided v2 quote for %s without altering it', (model, raw, prompt, completion, expected) => {
    const current = derive(raw, 1050000, model);
    expect(typeof current).toBe('object');
    expect(priceIncreases(prices(prompt, completion), current as FrozenPrices)).toEqual(expected);
  });

  it('rejects the v1 Sonnet input quote that excludes the cache write price', () => {
    const current = derive({ prompt: '0.000002', completion: '0.00001', input_cache_write: '0.0000025' },
      1000000, 'anthropic/claude-sonnet-5.5') as FrozenPrices;
    expect(priceIncreases(prices('2', '10'), current)).toEqual([{ field: 'prompt', frozen: '2', current: '2.5' }]);
  });
});

describe('priceIncreases', () => {
  it.each([
    ['prompt', prices('1.000000000001', '2', '0.1'), '1', '1.000000000001'],
    ['completion', prices('1', '2.000000000001', '0.1'), '2', '2.000000000001'],
    ['request', prices('1', '2', '0.100000000001'), '0.1', '0.100000000001'],
  ] as const)('detects a one-unit rise of %s independently', (field, current, frozen, value) => {
    expect(priceIncreases(prices('1', '2', '0.1'), current)).toEqual([{ field, frozen, current: value }]);
  });

  it('allows equality and decreases and reports all increases together', () => {
    expect(priceIncreases(prices('1.0', '2', '0.1'), prices('1', '2', '0.1'))).toEqual([]);
    expect(priceIncreases(prices('1', '2', '0.1'), prices('0.9', '1', '0'))).toEqual([]);
    expect(priceIncreases(prices('1', '2', '0.1'), prices('2', '3', '0.2')).map(item => item.field))
      .toEqual(['prompt', 'completion', 'request']);
  });
});
