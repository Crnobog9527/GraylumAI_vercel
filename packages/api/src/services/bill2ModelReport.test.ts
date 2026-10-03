/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { buildBill2ModelReport, type Bill2CallReportRow } from './bill2ModelReport';

function row(overrides: Partial<Bill2CallReportRow>): Bill2CallReportRow {
  return {
    call_id: 'c', run_id: 'r1', call_sequence: 1, created_at: '2026-10-01T00:00:00Z', provider: 'openrouter',
    model: 'vendor/sonnet', call_state: 'responded', selected_cost_usd: '0.01', run_state: 'settled', run_outcome: 'delivered',
    credits_per_usd: '1000', run_multiplier: '1.5', run_charged: 15, run_actual_restore: 0, run_call_count: 1,
    call_multiplier: null, multiplier_source: null, purpose: 'interactive', ...overrides,
  };
}

describe('BILL2 per-model finance report', () => {
  it('reports official cost and the frozen multiplier per model, exactly', () => {
    const report = buildBill2ModelReport([
      row({ call_id: 'a', selected_cost_usd: 0.000000000001 }),
      row({ call_id: 'b', run_id: 'r2', selected_cost_usd: '0.123456789012', call_multiplier: '3', multiplier_source: 'model', run_charged: 371 }),
    ], 5000);
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({
      calls: 2, unknownCostCalls: 0, officialCostUsd: '0.123456789013',
      weightedUsd: '0.3703703670375', attributedChargedCredits: 386,
      multipliers: [{ multiplier: '1.5', source: 'run', calls: 1 }, { multiplier: '3', source: 'call', calls: 1 }],
    });
    expect(report.totals).toMatchObject({ calls: 2, runs: 2, chargedCredits: 386, unallocatedChargedCredits: 0 });
    expect(report.truncated).toBe(false);
  });

  it('never splits a run-level charge across models or across a partial window', () => {
    const report = buildBill2ModelReport([
      row({ call_id: 'a', run_id: 'mixed', run_call_count: 2, run_charged: 9 }),
      row({ call_id: 'b', run_id: 'mixed', call_sequence: 2, model: 'vendor/luna', run_call_count: 2, run_charged: 9 }),
      row({ call_id: 'c', run_id: 'partial', run_call_count: 3, run_charged: 4 }),
    ], 5000);
    expect(report.models.map((m) => m.attributedChargedCredits)).toEqual([0, 0]);
    expect(report.totals).toMatchObject({ chargedCredits: 13, unallocatedChargedCredits: 13 });
  });

  it('keeps unknown costs and refunded runs out of the known totals', () => {
    const report = buildBill2ModelReport([
      row({ call_id: 'a', selected_cost_usd: null, call_state: 'unknown' }),
      row({ call_id: 'b', run_id: 'r2', run_state: 'refunded', run_charged: 20 }),
    ], 5000);
    expect(report.models[0]).toMatchObject({ unknownCostCalls: 1, officialCostUsd: null, attributedChargedCredits: 15 });
    expect(report.totals).toMatchObject({ refundedRuns: 1, chargedCredits: 15 });
  });

  it('new contract: attributes each call its cumulative difference Δ_i in sequence order', () => {
    const v2 = (o: Partial<Bill2CallReportRow>) => row({ run_id: 'n', credits_per_usd: '100', run_multiplier: '3', run_call_count: 2,
      run_charged: 1, selected_cost_usd: '0.002', ...o });
    const report = buildBill2ModelReport([
      v2({ call_id: 'b', call_sequence: 2, model: 'vendor/gemini', call_multiplier: '3' }),
      v2({ call_id: 'a', call_sequence: 1, model: 'vendor/sonnet', call_multiplier: '2' }),
    ], 5000);
    expect(report.models.map((m) => [m.model, m.attributedChargedCredits, m.weightedUsd])).toEqual([
      ['vendor/gemini', 0, '0.006'], ['vendor/sonnet', 1, '0.004'],
    ]);
    expect(report.totals).toMatchObject({ chargedCredits: 1, unallocatedChargedCredits: 0, platformAbsorbedCredits: null });
  });

  it('new contract: an unknown cost, a partial run or a charge that differs from ΣΔ stays unallocated', () => {
    const v2 = (o: Partial<Bill2CallReportRow>) => row({ credits_per_usd: '100', run_multiplier: '3', call_multiplier: '3', ...o });
    const report = buildBill2ModelReport([
      v2({ call_id: 'u', run_id: 'unknown', selected_cost_usd: null, run_charged: 2 }),
      v2({ call_id: 'p', run_id: 'partial', run_call_count: 2, run_charged: 3 }),
      v2({ call_id: 'd', run_id: 'differs', selected_cost_usd: '0.01', run_charged: 9 }),
    ], 5000);
    expect(report.models[0]!.attributedChargedCredits).toBe(0);
    expect(report.totals).toMatchObject({ chargedCredits: 14, unallocatedChargedCredits: 14 });
  });

  it('counts invalid multipliers separately and keeps their run unallocated instead of failing the report', () => {
    const report = buildBill2ModelReport([
      row({ call_id: 'x', run_id: 'bad', call_multiplier: '25', run_call_count: 2, run_charged: 7 }),
      row({ call_id: 'y', run_id: 'bad', call_sequence: 2, call_multiplier: '3', run_call_count: 2, run_charged: 7 }),
      row({ call_id: 'z', run_id: 'old', run_multiplier: '0' }),
    ], 5000);
    expect(report.totals).toMatchObject({ unparsableCalls: 2, unallocatedChargedCredits: 22 });
    expect(report.models[0]!.calls).toBe(1);
  });

  it('summarizes by purpose and by UTC date', () => {
    const report = buildBill2ModelReport([
      row({ call_id: 'a', purpose: 'interactive', created_at: '2026-10-01T23:00:00Z' }),
      row({ call_id: 'b', run_id: 'r2', purpose: 'organize', created_at: '2026-10-02T01:00:00Z', selected_cost_usd: '0.02' }),
      row({ call_id: 'c', run_id: 'r3', purpose: null, created_at: '2026-10-02T02:00:00Z' }),
    ], 5000);
    expect(report.byPurpose.map((g) => [g.key, g.calls, g.officialCostUsd])).toEqual([
      ['interactive', 1, '0.01'], ['organize', 1, '0.02'], ['unknown', 1, '0.01'],
    ]);
    expect(report.byDate.map((g) => [g.key, g.calls, g.weightedUsd])).toEqual([['2026-10-01', 1, '0.015'], ['2026-10-02', 2, '0.045']]);
  });

  it('flags a report that hit the row limit', () => {
    expect(buildBill2ModelReport([row({})], 1).truncated).toBe(true);
  });
});


describe('erasure financial report evidence', () => {
  it('retains a dispatched unknown run in list, groups, totals and serialized output', () => {
    const report = buildBill2ModelReport([row({
      selected_cost_usd: null, call_state: 'dispatched', run_state: 'cost_pending',
      run_outcome: 'cancelled', run_charged: null,
    })], 5000);
    expect(report.models[0]).toMatchObject({ calls: 1, unknownCostCalls: 1, officialCostUsd: null, weightedUsd: null });
    expect(report.totals).toMatchObject({ runs: 1, unsettledRuns: 1, refundedRuns: 0,
      officialCostUsd: null, weightedUsd: null });
    expect(report.byPurpose[0]).toMatchObject({ unknownCostCalls: 1, officialCostUsd: null, weightedUsd: null });
    expect(report.byDate[0]).toMatchObject({ unknownCostCalls: 1, officialCostUsd: null, weightedUsd: null });
    // The existing endpoint returns JSON; there is no BILL2 CSV/download endpoint.
    expect(JSON.parse(JSON.stringify(report)).totals.officialCostUsd).toBeNull();
  });

  it('does not present a known subtotal as a complete amount, but retains unrelated known model costs', () => {
    const report = buildBill2ModelReport([row({}), row({ run_id: 'unknown', model: 'other/model',
      selected_cost_usd: null, run_state: 'cost_pending', run_charged: null })], 5000);
    expect(report.models.find((line) => line.model === 'vendor/sonnet')?.officialCostUsd).toBe('0.01');
    expect(report.totals.officialCostUsd).toBeNull();
    expect(report.byPurpose[0]?.officialCostUsd).toBeNull();
  });

  it('distinguishes official zero evidence and known costs without token evidence from unknown costs', () => {
    // The v1 report has no token requirement: known official cost remains known without token usage.
    const report = buildBill2ModelReport([row({ selected_cost_usd: '0', run_charged: 0 }),
      row({ run_id: 'known', selected_cost_usd: '0.001', run_charged: 2 })], 5000);
    expect(report.totals).toMatchObject({ officialCostUsd: '0.001', unknownCostCalls: 0, unsettledRuns: 0 });
  });
});

it('keeps proven actual cost known without token counts; nominal/fallback charging remains the PAYG contract', () => {
  // The v1 report deliberately needs no token field. PAYG actual_fallback must preserve this
  // actual-cost fact, while its separate nominal fee remains not applicable to v1.
  const known = buildBill2ModelReport([row({ selected_cost_usd: '0.003' })], 100);
  expect(known.models[0]).toMatchObject({ officialCostUsd: '0.003', unknownCostCalls: 0 });
  const pending = buildBill2ModelReport([row({ selected_cost_usd: null, run_state: 'dispatched', run_charged: null })], 100);
  expect(pending.totals).toMatchObject({ officialCostUsd: null, unsettledRuns: 1 });
});


describe('0162 SQL projection through the full model/PAYG report chain', () => {
  it('accepts bill2.v2 and SQL text credits, preserving totals and C+E=N', () => {
    // Same scalar types as bill2_admin_call_report: charged/refund are integers;
    // theoretical/absorbed credits and decimals are SQL ::text, timestamps are JSON strings.
    const sqlRow = row({ contract_version: 'bill2.v2', settled_at: '2026-10-03T00:00:00Z',
      run_state: 'running', run_charged: null, run_call_count: 2,
      credits_per_usd: '1000', call_multiplier: '1', multiplier_source: 'model',
      selected_cost_usd: '0.005000000000', nominal_cost_usd: '0.005000000000000000',
      nominal_source: 'nominal', charged_delta: 2, theoretical_delta: '5',
      platform_absorbed_cap_credits: '3', platform_absorbed_bound_credits: '0',
      platform_absorbed_cap_usd: '0.00300000000000000000', platform_absorbed_bound_usd: '0',
      platform_margin_cache_read_usd: '0', platform_margin_cache_write_usd: '0', platform_margin_other_usd: '0',
      compensation_credits: 0, compensated_at: null });
    const report = buildBill2ModelReport([sqlRow, { ...sqlRow, call_id: 'c2', call_sequence: 2,
      selected_cost_usd: '0.010000000000', nominal_cost_usd: '0.010000000000000000',
      charged_delta: 4, theoretical_delta: '10', platform_absorbed_cap_credits: '0',
      platform_absorbed_bound_credits: '6', platform_absorbed_cap_usd: '0',
      platform_absorbed_bound_usd: '0.00600000000000000000',
      compensation_credits: 1, compensated_at: '2026-10-04T00:00:00Z' }], 5000);
    expect(report.totals).toMatchObject({ calls: 2, chargedCredits: 6, unallocatedChargedCredits: 0,
      officialCostUsd: '0.015', platformAbsorbedCredits: 9, paygRefundedCredits: 1, paygNetChargedCredits: 5 });
    expect(report.models[0]).toMatchObject({ calls: 2, attributedChargedCredits: 6 });
    expect(report.payg).toMatchObject({ complete: true, invalidCalls: 0, unsettledCalls: 0,
      platformAbsorbedCredits: 9, groups: [{ calls: 2, chargedCredits: 6, theoreticalCredits: 15,
        capCredits: 3, boundCredits: 6, nominalCostUsd: '0.015', officialCostUsd: '0.015',
        platformMarginUsd: '0', compensationCredits: 1, netChargedCredits: 5 }] });
    expect(report.payg.calls).toHaveLength(2);
    for (const call of report.payg.calls) {
      expect(call.chargedCredits + call.capCredits + call.boundCredits).toBe(call.theoreticalCredits);
    }
    const group = report.payg.groups[0]!;
    expect(group.chargedCredits + group.capCredits + group.boundCredits).toBe(group.theoreticalCredits);
  });
});
