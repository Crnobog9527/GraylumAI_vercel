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
      row({ call_id: 'b', run_id: 'r2', selected_cost_usd: '0.123456789012', call_multiplier: '3', multiplier_source: 'model', run_charged: 38 }),
    ], 5000);
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({
      calls: 2, unknownCostCalls: 0, officialCostUsd: '0.123456789013',
      weightedUsd: '0.3703703670375', attributedChargedCredits: 53,
      multipliers: [{ multiplier: '1.5', source: 'run', calls: 1 }, { multiplier: '3', source: 'call', calls: 1 }],
    });
    expect(report.totals).toMatchObject({ calls: 2, runs: 2, chargedCredits: 53, unallocatedChargedCredits: 0 });
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
    expect(report.models[0]).toMatchObject({ unknownCostCalls: 1, officialCostUsd: '0.01', attributedChargedCredits: 15 });
    expect(report.totals).toMatchObject({ refundedRuns: 1, chargedCredits: 15 });
  });

  it('flags a report that hit the row limit', () => {
    expect(buildBill2ModelReport([row({})], 1).truncated).toBe(true);
  });
});
