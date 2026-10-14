/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { providerUsageCostUsd, resolveProviderPrice, type ProviderPrices } from '../billingProviderPrices';
import type { ResearchCallResult } from '../research/vendors/types';
import {
  toolCallPolicy, toolClaimPayload, toolCostUsd, toolResultEvidence, ToolBillingError, type ToolPricing,
} from './toolBilling';

const at = new Date('2026-10-14T00:00:00Z');
const entry = (patch: Partial<ProviderPrices['entries'][number]> = {}): ProviderPrices['entries'][number] => ({
  provider: 'tikhub', route: '/tiktok/app/v3/handler_user_profile', appliesToUnlistedRoutes: false, currency: 'USD',
  usageUnit: 'call', unitsPerPrice: '1', price: '0.01', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null,
  fxValidUntil: null, pricingBasis: 'official per-call price', sourceUrl: 'https://tikhub.io/pricing',
  evidenceHash: 'a'.repeat(64), verifiedAt: '2026-10-13T00:00:00Z', validUntil: '2026-10-20T00:00:00Z',
  chargeCondition: 'every call', includedInReceipt: false, priceMultiplier: null, ...patch,
});
const resolve = (e = entry()) => resolveProviderPrice({ version: 1, entries: [e] }, { provider: e.provider, route: e.route! }, '6', at);
const policy = (e = entry(), maxUnitsPerCall = '1') => toolCallPolicy({
  vendor: e.provider as 'tikhub', account: 'tikhub-main', route: e.route!, purposes: ['question'], price: resolve(e), maxUnitsPerCall,
});
const result = (patch: Partial<ResearchCallResult>): ResearchCallResult => ({
  vendor: 'tikhub', route: '/tiktok/app/v3/handler_user_profile', outcome: 'ok', reason: null, httpStatus: 200,
  supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items: [], truncated: false,
  fetchedAt: '2026-10-14T00:00:01.000Z', ...patch,
});
const hash = 'c'.repeat(64);

describe('tool billing payloads', () => {
  it('freezes the resolved price, bound and multiplier into the policy and claim', () => {
    const p = policy();
    expect(p).toMatchObject({ provider: 'tikhub', model: 'tikhub:/tiktok/app/v3/handler_user_profile', modelId: p.model,
      protocol: 'research-tool-v1', multiplier: '6', upperUsd: '0.01', lookupSupported: false,
      toolPricing: { unit: 'call', price: '0.01', unitsPerPrice: '1', usdPerCurrency: null, maxUnitsPerCall: '1',
        validUntil: '2026-10-20T00:00:00Z' } });
    expect(toolClaimPayload(p, { phase: 'question', requestHash: 'd'.repeat(64), runtimeEpoch: '3' })).toEqual({
      provider: 'tikhub', account: 'tikhub-main', model: p.model, protocol: 'research-tool-v1', phase: 'question',
      requestHash: 'd'.repeat(64), automaticRetry: false, hiddenTools: false, lookupSupported: false, upperUsd: '0.01',
      billingUnit: { modelId: p.model, multiplier: '6' }, toolPricing: p.toolPricing, runtimeEpoch: '3' });
    expect(() => toolClaimPayload(p, { phase: 'report', requestHash: 'd'.repeat(64) })).toThrow(ToolBillingError);
  });

  it('refuses prices that cannot charge a search call', () => {
    expect(() => policy(entry({ validUntil: null }))).toThrow('TOOL_PRICE_EXPIRY_REQUIRED');
    expect(() => policy(entry({ includedInReceipt: true }))).toThrow('TOOL_PRICE_NOT_CHARGEABLE');
    expect(() => policy(entry({ usageUnit: 'credit' }))).toThrow('TOOL_PRICE_UNIT_MISMATCH');
    expect(() => policy(entry({ price: '0' }))).toThrow('TOOL_BOUND_INVALID');
    expect(() => policy(entry(), '0')).toThrow('TOOL_INPUT_INVALID');
  });

  it('computes cost exactly like providerUsageCostUsd, including other currencies', () => {
    const cases: Array<[Partial<ProviderPrices['entries'][number]>, string]> = [
      [{ price: '1', unitsPerPrice: '1000', usageUnit: 'sku_search', provider: 'parallel', route: 'parallel:search:fast' }, '1'],
      [{ price: '0.0003', unitsPerPrice: '7' }, '3'],
      [{ currency: 'CNY', usdPerCurrency: '0.138888888889', fxSourceUrl: 'https://example.com/fx',
        fxEffectiveAt: '2026-10-13T00:00:00Z', fxValidUntil: '2026-10-30T00:00:00Z', price: '0.07' }, '1'],
    ];
    for (const [patch, units] of cases) {
      const resolved = resolve(entry(patch));
      const pricing: ToolPricing = { unit: 'call', currency: resolved.entry.currency, price: resolved.entry.price,
        unitsPerPrice: resolved.entry.unitsPerPrice, usdPerCurrency: resolved.entry.usdPerCurrency, entryHash: resolved.entryHash,
        validUntil: resolved.entry.validUntil!, maxUnitsPerCall: '1' };
      for (const rounding of ['up', 'down'] as const) {
        expect(toolCostUsd(pricing, units, rounding)).toBe(providerUsageCostUsd(resolved, units, rounding).costUsd);
      }
    }
  });
});

describe('tool result evidence', () => {
  const p = policy();
  it('maps adapter outcomes to the four recorded outcomes', () => {
    expect(toolResultEvidence('call-1', p, result({}), hash)).toMatchObject({
      providerId: 'call-1', toolOutcome: 'delivered', cost: '0.01', usage: { unit: 'call', units: '1' }, httpStatus: 200,
      evidenceKind: 'tool_result', coverage: 'request_total', final: true, currency: 'USD' });
    expect(toolResultEvidence('call-1', p, result({ outcome: 'partial', usage: { unit: 'call', units: null } }), hash))
      .toMatchObject({ toolOutcome: 'delivered', cost: null, usage: { units: null } });
    expect(toolResultEvidence('call-1', p, result({ outcome: 'failed', supplierMayCharge: false, httpStatus: 401 }), hash))
      .toMatchObject({ toolOutcome: 'failed_free', cost: '0', usage: { units: null } });
    expect(toolResultEvidence('call-1', p, result({ outcome: 'failed', supplierMayCharge: true, usage: { unit: 'call', units: null } }), hash))
      .toMatchObject({ toolOutcome: 'failed_charged', cost: '0.01', usage: { units: '1' } });
    const unknown = toolResultEvidence('call-1', p, result({ outcome: 'unknown', httpStatus: null, usage: { unit: 'call', units: null } }), hash);
    expect(unknown).toMatchObject({ toolOutcome: 'unknown', cost: null, usage: { units: null } });
    expect(unknown).not.toHaveProperty('httpStatus');
    expect(toolResultEvidence('call-1', p, result({ outcome: 'not_sent' }), hash)).toBeNull();
  });

  it('never prices usage reported in another unit or for a usage route without usage', () => {
    expect(toolResultEvidence('call-1', p, result({ usage: { unit: 'credit', units: '5' } }), hash))
      .toMatchObject({ toolOutcome: 'delivered', cost: null, usage: { unit: 'call', units: null } });
    const parallel = policy(entry({ provider: 'parallel', route: 'parallel:search:fast', usageUnit: 'sku_search', price: '0.001' }));
    expect(toolResultEvidence('call-2', parallel, result({ vendor: 'parallel', route: 'parallel:search:fast', outcome: 'failed', supplierMayCharge: true,
      usage: { unit: 'sku_search', units: null } }), hash)).toMatchObject({ toolOutcome: 'unknown', cost: null });
  });

  it('refuses a result from another vendor or route before pricing it', () => {
    expect(() => toolResultEvidence('call-1', p, result({ route: '/tiktok/app/v3/fetch_user_post_videos' }), hash))
      .toThrow('TOOL_RESULT_MISMATCH');
    expect(() => toolResultEvidence('call-1', p, result({ vendor: 'parallel' }), hash)).toThrow('TOOL_RESULT_MISMATCH');
    expect(() => toolResultEvidence('call-1', p, result({ route: 'other', outcome: 'not_sent' }), hash)).toThrow('TOOL_RESULT_MISMATCH');
  });

  it('records usage above the bound as reported (the database flags it)', () => {
    expect(toolResultEvidence('call-1', p, result({ usage: { unit: 'call', units: '2' } }), hash))
      .toMatchObject({ toolOutcome: 'delivered', cost: '0.02', usage: { units: '2' } });
  });
});
