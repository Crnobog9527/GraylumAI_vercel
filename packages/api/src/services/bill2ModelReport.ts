/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { usdToPico } from './reportUsd';
import { formatWeightedUsd } from './bill2/weighted';

/**
 * BILL-UNIT finance projection: per provider/model official cost, the multiplier actually frozen
 * for each call and the weighted "nominal" amount (cost × m_i). Nominal amounts are pricing values,
 * not cash revenue. Credits charged at run level are attributed to a model only when the whole run
 * is in the report and used that one model; everything else stays explicitly unallocated.
 */
export type Bill2CallReportRow = {
  call_id: string;
  run_id: string;
  call_sequence: number;
  created_at: string;
  provider: string;
  model: string;
  call_state: string;
  selected_cost_usd: string | number | null;
  run_state: string;
  run_outcome: string | null;
  credits_per_usd: string | number;
  run_multiplier: string | number;
  run_charged: number | null;
  run_actual_restore: number | null;
  run_call_count: number;
  call_multiplier: string | null;
  multiplier_source: string | null;
  purpose: string | null;
};

export type ModelReportLine = {
  provider: string;
  model: string;
  calls: number;
  unknownCostCalls: number;
  officialCostUsd: string;
  weightedUsd: string;
  multipliers: Array<{ multiplier: string; source: 'call' | 'run'; calls: number }>;
  attributedChargedCredits: number;
};

const PICO = 10n ** 12n;
const picoText = (pico: bigint) => {
  const fraction = (pico % PICO).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${pico / PICO}.${fraction}` : (pico / PICO).toString();
};

export function buildBill2ModelReport(rows: readonly Bill2CallReportRow[], limit: number) {
  const lines = new Map<string, ModelReportLine & { cost: bigint; weighted: bigint }>();
  const runs = new Map<string, { charged: number; refunded: boolean; expected: number; seen: number; models: Set<string> }>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`;
    const line = lines.get(key) ?? { provider: row.provider, model: row.model, calls: 0, unknownCostCalls: 0,
      officialCostUsd: '0', weightedUsd: '0', multipliers: [], attributedChargedCredits: 0, cost: 0n, weighted: 0n };
    // A per-call frozen m_i (new contract) wins; old single-multiplier runs report the run's m.
    const source: 'call' | 'run' = row.call_multiplier !== null ? 'call' : 'run';
    const multiplierPico = usdToPico(source === 'call' ? row.call_multiplier : row.run_multiplier);
    const multiplier = picoText(multiplierPico);
    line.calls += 1;
    if (row.selected_cost_usd === null) {
      line.unknownCostCalls += 1;
    } else {
      const cost = usdToPico(row.selected_cost_usd);
      line.cost += cost;
      line.weighted += cost * multiplierPico;
    }
    const seen = line.multipliers.find((m) => m.multiplier === multiplier && m.source === source);
    if (seen) seen.calls += 1; else line.multipliers.push({ multiplier, source, calls: 1 });
    lines.set(key, line);
    const run = runs.get(row.run_id) ?? { charged: row.run_charged ?? 0, refunded: row.run_state === 'refunded',
      expected: row.run_call_count, seen: 0, models: new Set<string>() };
    run.seen += 1;
    run.models.add(key);
    runs.set(row.run_id, run);
  }
  let chargedCredits = 0;
  let unallocatedChargedCredits = 0;
  let refundedRuns = 0;
  for (const run of runs.values()) {
    if (run.refunded) { refundedRuns += 1; continue; }
    chargedCredits += run.charged;
    const only = run.models.size === 1 && run.seen === run.expected ? [...run.models][0]! : null;
    if (only) lines.get(only)!.attributedChargedCredits += run.charged;
    else unallocatedChargedCredits += run.charged;
  }
  let totalCost = 0n;
  let totalWeighted = 0n;
  const models = [...lines.values()].map(({ cost, weighted, ...line }) => {
    totalCost += cost;
    totalWeighted += weighted;
    return { ...line, officialCostUsd: picoText(cost), weightedUsd: formatWeightedUsd(weighted) };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return {
    models,
    totals: {
      calls: rows.length,
      runs: runs.size,
      refundedRuns,
      officialCostUsd: picoText(totalCost),
      weightedUsd: formatWeightedUsd(totalWeighted),
      chargedCredits,
      unallocatedChargedCredits,
    },
    truncated: rows.length >= limit,
  };
}
