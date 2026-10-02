/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect } from 'vitest';
import { modelPriceView } from './modelPriceView';
import { pricedModel } from './__tests__/modelPriceFixture';
import { modelCapacityView, supplierCapacityPatch } from './modelCapacityView';

describe('snapshot report and capacity views', () => {
  it('uses base and highest applicable frozen prices, never legacy prices', () => {
    const row = { ...pricedModel(), input_token_cost: 999999999 };
    expect(modelPriceView(row)).toMatchObject({ status: 'ready', base: { prompt: '2', input_cache_read: '0.25' },
      frozen: { promptUsdPerMillion: '3', completionUsdPerMillion: '5' } });
    expect(modelPriceView({ model_id: row.model_id })).toMatchObject({ status: 'unread', label: '未读取', base: null, frozen: null });
    expect(modelPriceView({ ...row, model_id: 'changed/model' })).toMatchObject({ status: 'model_mismatch', base: null, frozen: null });
  });
  it('refuses frozen reports for missing routes, malformed snapshots and unknown price keys', () => {
    const row = pricedModel();
    row.config.reasoning.route = 'missing';
    expect(modelPriceView(row)).toMatchObject({ status: 'route_unavailable', base: null, frozen: null });
    row.config.reasoning.route = 'openai';
    row.config.pricing.endpoints[0]!.unknownKeys = ['new_charge'];
    expect(modelPriceView(row)).toMatchObject({ status: 'UNKNOWN_PRICE_FIELD', frozen: null });
    row.config.pricing.pricingHash = 'malformed';
    expect(modelPriceView(row)).toMatchObject({ status: 'unread', base: null, frozen: null });
  });
  it('reports differences without writing and prepares supplier limits only when explicitly called', () => {
    const row = { ...pricedModel(), max_tokens: 8192, input_limit: 180000 };
    expect(modelCapacityView(row)).toMatchObject({ inputLimit: { supplier: 1000000, current: 180000, matches: false },
      maxTokens: { supplier: 128000, current: 8192, matches: false } });
    expect(supplierCapacityPatch(row)).toEqual({ input_limit: 1000000, max_tokens: 128000 });
    expect(row.max_tokens).toBe(8192);
    expect(supplierCapacityPatch({ ...row, model_id: 'changed/model' })).toEqual({});
  });
  it('handles duplicate tags conservatively and does not invent missing capacities', () => {
    const row = { ...pricedModel(), max_tokens: 8192, input_limit: 180000 };
    row.config.reasoning.catalog.endpoints.push({ ...row.config.reasoning.catalog.endpoints[0]!, contextLength: 500000, maxCompletionTokens: 16000 });
    expect(supplierCapacityPatch(row)).toEqual({ input_limit: 500000, max_tokens: 16000 });
    row.config.reasoning.catalog.endpoints[0]!.maxCompletionTokens = null as never;
    expect(supplierCapacityPatch(row)).toEqual({ input_limit: 500000 });
  });
});
