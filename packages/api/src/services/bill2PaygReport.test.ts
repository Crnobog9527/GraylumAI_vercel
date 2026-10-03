/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { buildPaygReport } from './bill2PaygReport';
const call = {
  credits_per_usd: '100', call_multiplier: '3',
  call_id: 'a', provider: 'openrouter', model: 'v/a', purpose: 'interactive', contract_version: 2,
  settled_at: '2026-10-02T23:00:00-02:00', selected_cost_usd: '0.034', nominal_cost_usd: '0.106', nominal_source: 'nominal',
  charged_delta: 30, theoretical_delta: 32, platform_absorbed_cap_credits: 2, platform_absorbed_bound_credits: 0,
  platform_margin_cache_read_usd: '0.072', platform_margin_cache_write_usd: '0', platform_margin_other_usd: '0',
};
describe('PAYG report evidence', () => {
  it('groups model/purpose/settlement UTC date and preserves monetary and credit identities', () => {
    const report = buildPaygReport([call, { ...call, call_id: 'b', selected_cost_usd: '0.126',
      platform_margin_cache_read_usd: '0', platform_margin_cache_write_usd: '-0.020' }]);
    expect(report).toMatchObject({ invalidCalls: 0, platformAbsorbedCredits: 4, groups: [{
      calls: 2, utcDate: '2026-10-03', officialCostUsd: '0.16', nominalCostUsd: '0.212', platformMarginUsd: '0.052',
      chargedCredits: 60, theoreticalCredits: 64, capCredits: 4, cappedCalls: 2,
    }] });
    expect(report.calls[1]?.cacheWriteMarginUsd).toBe('-0.02');
  });
  it('keeps fallback outside cache/discount statistics and preserves sub-pico nominal precision', () => {
    const report = buildPaygReport([{ ...call, nominal_source: 'actual_fallback',
      nominal_cost_usd: '0.034000000000000001' }]);
    expect(report.calls[0]).toMatchObject({ nominalCostUsd: '0.034000000000000001',
      platformMarginUsd: '0.000000000000000001', marginBreakdownAvailable: false, cacheReadMarginUsd: null });
    expect(report.groups[0]).toMatchObject({ actualFallbackCalls: 1, nominalMarginUsd: '0',
      actualFallbackMarginUsd: '0.000000000000000001' });
  });
  it('excludes proven zero-charge unsent releases from charged statistics', () => {
    expect(buildPaygReport([{ ...call, nominal_source: 'not_dispatched', nominal_cost_usd: '0', selected_cost_usd: '0',
      charged_delta: 0, theoretical_delta: 0, platform_absorbed_cap_credits: 0 }]))
      .toMatchObject({ calls: [], releasedUnsentCalls: 1, invalidCalls: 0 });
  });
  it('does not fabricate settled, valid, or duplicate financial evidence', () => {
    expect(buildPaygReport([{ ...call, settled_at: null }])).toMatchObject({ unsettledCalls: 1, calls: [] });
    expect(buildPaygReport([{ ...call, charged_delta: 31 }])).toMatchObject({ invalidCalls: 1,
      complete: false, platformAbsorbedCredits: null, calls: [] });
    expect(buildPaygReport([call, call])).toMatchObject({ invalidCalls: 1, platformAbsorbedCredits: null });
    expect(buildPaygReport([{ ...call, contract_version: 1 }])).toMatchObject({ calls: [], invalidCalls: 0 });
  });
});


describe('PAYG compensation projection', () => {
  it('reports actual restored credits separately without changing gross conservation or absorption', () => {
    const report = buildPaygReport([{ ...call, compensation_credits: 20, compensated_at: '2026-10-04T00:00:00Z' }]);
    expect(report).toMatchObject({ refundedCredits: 20, netChargedCredits: 10, platformAbsorbedCredits: 2,
      groups: [{ chargedCredits: 30, compensationCredits: 20, netChargedCredits: 10, theoreticalCredits: 32, capCredits: 2 }] });
    expect(report.calls[0]).toMatchObject({ compensatedAt: '2026-10-04T00:00:00Z', officialCostUsd: '0.034',
      nominalCostUsd: '0.106', chargedCredits: 30, compensationCredits: 20, netChargedCredits: 10 });
  });
  it('retains denied restoration as zero and rejects compensation exceeding original charge', () => {
    expect(buildPaygReport([{ ...call, compensation_credits: 0, compensated_at: '2026-10-04T00:00:00Z' }]))
      .toMatchObject({ refundedCredits: 0, netChargedCredits: 30, invalidCalls: 0 });
    expect(buildPaygReport([{ ...call, compensation_credits: 31, compensated_at: '2026-10-04T00:00:00Z' }]))
      .toMatchObject({ refundedCredits: null, netChargedCredits: null, invalidCalls: 1 });
  });
  it('confirmed failure releases are not charged calls and never fabricate unknown supplier cost as zero', () => {
    const report = buildPaygReport([{ ...call, nominal_source: 'confirmed_failure', nominal_cost_usd: '0',
      selected_cost_usd: null, charged_delta: 0, theoretical_delta: 0, platform_absorbed_cap_credits: 0 }]);
    expect(report).toMatchObject({ calls: [], groups: [], invalidCalls: 0, refundedCredits: 0, netChargedCredits: 0,
      releasedFailureCalls: [{ callId: 'a', officialCostUsd: null, providerCostKnown: false, nominalCostUsd: '0' }] });
  });
});
