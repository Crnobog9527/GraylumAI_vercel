/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { normalizeEndpointPricing, type PricingSnapshot } from '@repo/api/src/shared/modelPricing';
import { describeChange, priceRows, selectedRoute, snapshotAge } from './modelPriceView';

const luna = normalizeEndpointPricing('openai', 1050000, {
  prompt: '0.0000001', completion: '0.0000005', input_cache_write: '0.000000125', web_search: '0.01', discount: 0,
  overrides: [{ min_prompt_tokens: 272000, prompt: '0.0000002', completion: '0.00000075' }],
});
const snapshot: PricingSnapshot = {
  fetchedAt: '2026-10-02T00:00:00.000Z', model: 'openai/gpt-6-luna', source: 'openrouter:/api/v1/models/openai/gpt-6-luna/endpoints',
  pricingHash: 'a'.repeat(64), endpoints: [luna, normalizeEndpointPricing('azure', 1050000, { prompt: '0.0000001' })],
};

describe('model price view', () => {
  it('lists only the prices present, in OpenRouter terms, with units', () => {
    expect(priceRows(luna.base)).toEqual([
      { key: 'prompt', label: '输入', value: '0.1', unit: '美元 / 百万 token' },
      { key: 'completion', label: '输出', value: '0.5', unit: '美元 / 百万 token' },
      { key: 'input_cache_write', label: '缓存写入（5 分钟）', value: '0.125', unit: '美元 / 百万 token' },
      { key: 'web_search', label: '联网搜索', value: '0.01', unit: '美元 / 次' },
    ]);
  });

  it('shows the selected route with its tiers, and explains each missing state', () => {
    const selected = selectedRoute(snapshot, 'openai', 'openai/gpt-6-luna');
    expect(selected).toMatchObject({ state: 'ok', view: { admissible: true, tiers: [{ condition: '输入 ≥ 272,000 token' }] } });
    expect(selectedRoute(snapshot, 'azure', 'openai/gpt-6-luna')).toMatchObject({ state: 'ok', view: { admissible: false, problems: ['缺少输入或输出单价'] } });
    expect(selectedRoute(null, 'openai', 'openai/gpt-6-luna').state).toBe('missing');
    expect(selectedRoute(snapshot, 'openai', 'openai/gpt-6-luna-pro').state).toBe('model_changed');
    expect(selectedRoute(snapshot, null, 'openai/gpt-6-luna').state).toBe('no_route');
    expect(selectedRoute(snapshot, 'openai/flex', 'openai/gpt-6-luna').state).toBe('route_missing');
  });

  it('marks a snapshot older than 7 days as stale', () => {
    const read = Date.parse('2026-10-02T00:00:00.000Z'), day = 24 * 60 * 60 * 1000;
    expect(snapshotAge('2026-10-02T00:00:00.000Z', read + 7 * day)).toEqual({ days: 7, stale: false });
    expect(snapshotAge('2026-10-02T00:00:00.000Z', read + 7 * day + 1)).toEqual({ days: 7, stale: true });
  });

  it('describes changes in plain words and flags a rise', () => {
    expect(describeChange({ tag: 'openai', change: 'changed', field: 'overrides[0].prompt', before: '0.2', after: '0.25' }))
      .toBe('openai · overrides[0].输入：0.2 → 0.25（上涨）');
    expect(describeChange({ tag: 'openai', change: 'changed', field: 'prompt', before: '0.2', after: '0.1' })).toBe('openai · 输入：0.2 → 0.1');
    expect(describeChange({ tag: 'azure', change: 'removed' })).toBe('线路 azure 已不在目录里');
  });
});
