/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { usdToPico } from './reportUsd';
import { formatWeightedUsd, weightedDeltaCredits } from './bill2/weighted';
import { parseMultiplier } from './billingUnit';

/**
 * BILL-UNIT finance projection: per provider/model official cost, the multiplier actually frozen
 * for each call and the weighted "nominal" amount (cost × m_i). Nominal amounts are pricing values,
 * not cash revenue. Run-level charges are attributed to models only with evidence:
 * - new contract (per-call m_i): each call's cumulative difference Δ_i = ceil(q×W_after) − ceil(q×W_before)
 *   in sequence order, when the whole run is in the window, every cost is known and ΣΔ equals the charge;
 * - old contract: the whole charge, when the whole run is in the window and used one model.
 * Everything else is reported as unallocated. 0157 settles all-or-conflict, so there is no
 * platform-absorbed amount yet (BILL-PAYG adds it).
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
type GroupLine = { key: string; calls: number; officialCostUsd: string; weightedUsd: string };

const PICO = 10n ** 12n;
const picoText = (pico: bigint) => {
  const fraction = (pico % PICO).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${pico / PICO}.${fraction}` : (pico / PICO).toString();
};
const PICO_DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/;

type Parsed = { row: Bill2CallReportRow; key: string; source: 'call' | 'run'; multiplier: string; mPico: bigint; cost: bigint | null };

function parseRow(row: Bill2CallReportRow): Parsed | null {
  const source: 'call' | 'run' = row.call_multiplier !== null ? 'call' : 'run';
  try {
    // New-contract multipliers must be valid BILL-UNIT values; old runs report the run's positive m.
    const text = source === 'call' ? parseMultiplier(row.call_multiplier) : String(row.run_multiplier);
    const mPico = usdToPico(text);
    if (mPico <= 0n) return null;
    const cost = row.selected_cost_usd === null ? null : usdToPico(row.selected_cost_usd);
    if (cost !== null && cost < 0n) return null;
    return { row, key: `${row.provider}\u0000${row.model}`, source, multiplier: picoText(mPico), mPico, cost };
  } catch {
    return null;
  }
}

/** Δ_i per call for one fully visible new-contract run, or null when it cannot be proven. */
function newContractDeltas(calls: Parsed[], creditsPerUsd: string, charged: number): number[] | null {
  if (calls.some((call) => call.cost === null) || !PICO_DECIMAL.test(creditsPerUsd)) return null;
  let units = 0n;
  const deltas: number[] = [];
  for (const call of [...calls].sort((a, b) => a.row.call_sequence - b.row.call_sequence)) {
    const step = weightedDeltaCredits(units, { costUsd: picoText(call.cost!), multiplier: call.multiplier }, creditsPerUsd);
    units = step.units;
    deltas.push(step.delta);
  }
  return deltas.reduce((a, b) => a + b, 0) === charged ? deltas : null;
}

function addGroup(groups: Map<string, { calls: number; cost: bigint; weighted: bigint }>, key: string, p: Parsed) {
  const group = groups.get(key) ?? { calls: 0, cost: 0n, weighted: 0n };
  group.calls += 1;
  if (p.cost !== null) { group.cost += p.cost; group.weighted += p.cost * p.mPico; }
  groups.set(key, group);
}
const groupLines = (groups: Map<string, { calls: number; cost: bigint; weighted: bigint }>): GroupLine[] =>
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, g]) => ({ key, calls: g.calls, officialCostUsd: picoText(g.cost), weightedUsd: formatWeightedUsd(g.weighted) }));

export function buildBill2ModelReport(rows: readonly Bill2CallReportRow[], limit: number) {
  const lines = new Map<string, ModelReportLine & { cost: bigint; weighted: bigint }>();
  const runs = new Map<string, { row: Bill2CallReportRow; calls: Parsed[]; invalid: boolean }>();
  const byPurpose = new Map<string, { calls: number; cost: bigint; weighted: bigint }>();
  const byDate = new Map<string, { calls: number; cost: bigint; weighted: bigint }>();
  let invalidMultiplierCalls = 0;
  for (const row of rows) {
    const run = runs.get(row.run_id) ?? { row, calls: [], invalid: false };
    runs.set(row.run_id, run);
    const parsed = parseRow(row);
    if (!parsed) { invalidMultiplierCalls += 1; run.invalid = true; continue; }
    run.calls.push(parsed);
    const line = lines.get(parsed.key) ?? { provider: row.provider, model: row.model, calls: 0, unknownCostCalls: 0,
      officialCostUsd: '0', weightedUsd: '0', multipliers: [], attributedChargedCredits: 0, cost: 0n, weighted: 0n };
    line.calls += 1;
    if (parsed.cost === null) line.unknownCostCalls += 1;
    else { line.cost += parsed.cost; line.weighted += parsed.cost * parsed.mPico; }
    const seen = line.multipliers.find((m) => m.multiplier === parsed.multiplier && m.source === parsed.source);
    if (seen) seen.calls += 1; else line.multipliers.push({ multiplier: parsed.multiplier, source: parsed.source, calls: 1 });
    lines.set(parsed.key, line);
    addGroup(byPurpose, row.purpose ?? 'unknown', parsed);
    addGroup(byDate, String(row.created_at).slice(0, 10), parsed);
  }
  let chargedCredits = 0;
  let unallocatedChargedCredits = 0;
  let refundedRuns = 0;
  for (const run of runs.values()) {
    if (run.row.run_state === 'refunded') { refundedRuns += 1; continue; }
    const charged = run.row.run_charged ?? 0;
    chargedCredits += charged;
    const complete = !run.invalid && run.calls.length === run.row.run_call_count;
    const newContract = run.calls.some((call) => call.source === 'call');
    const deltas = complete && newContract ? newContractDeltas(run.calls, String(run.row.credits_per_usd), charged) : null;
    if (deltas) {
      [...run.calls].sort((a, b) => a.row.call_sequence - b.row.call_sequence)
        .forEach((call, index) => { lines.get(call.key)!.attributedChargedCredits += deltas[index]!; });
      continue;
    }
    const models = new Set(run.calls.map((call) => call.key));
    if (complete && !newContract && models.size === 1) lines.get([...models][0]!)!.attributedChargedCredits += charged;
    else unallocatedChargedCredits += charged;
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
    byPurpose: groupLines(byPurpose),
    byDate: groupLines(byDate),
    totals: {
      calls: rows.length,
      runs: runs.size,
      refundedRuns,
      invalidMultiplierCalls,
      officialCostUsd: picoText(totalCost),
      weightedUsd: formatWeightedUsd(totalWeighted),
      chargedCredits,
      unallocatedChargedCredits,
      platformAbsorbedCredits: null,
    },
    truncated: rows.length >= limit,
  };
}
