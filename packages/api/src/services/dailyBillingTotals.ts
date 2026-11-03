/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

// ARCH-FIX E2: the day's totals and ledger checks are counted in the database (billing_reconcile_day), so the
// result does not depend on how many rows one API read may return.
export type DailyBillingTotals = {
  tokenStatsCount: number;
  tokenStatsCredits: number;
  webSearchCount: number;
  successfulAiRequests: number;
  settleCredits: number;
  completedPaymentOrders: number;
  completedPaymentAmount: number;
  calls: { settledCalls: number; mismatched: number; sample: string[] };
  turns: { settledTurns: number; mismatched: number; sample: Array<{ actorId: string; turnId: string }> };
  sources: { mismatched: number; sample: Array<{ kind: string; id: string }> };
  entries: { unattributed: number; notApplied: number };
};

const integer = (value: unknown, nonNegative = true): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (nonNegative && value < 0)) {
    throw new Error('Invalid daily billing reconciliation totals');
  }
  return value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid daily billing reconciliation totals');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Invalid daily billing reconciliation totals');
  return value;
};

export async function readDailyBillingTotals(supabase: SupabaseClient, start: string, end: string): Promise<DailyBillingTotals> {
  const result = await supabase.rpc('billing_reconcile_day', { p_start: start, p_end: end });
  if (result.error) throw result.error;
  const data = record(result.data);
  // The turns block arrives with migration 0487; before it is applied the function has none, so it reads as zero turns.
  const turns = data.turns === undefined ? { settledTurns: 0, mismatched: 0, sample: [] } : record(data.turns);
  // The old per-call ledger block is gone from the function once the old execution path is dropped (V2-12 F); a result without it
  // reads as no settled calls and no mismatches. A block that is present is still validated.
  const calls = data.calls === undefined ? { settledCalls: 0, mismatched: 0, sample: [] } : record(data.calls);
  const sources = record(data.sources), entries = record(data.entries);
  return {
    tokenStatsCount: integer(data.tokenStatsCount),
    tokenStatsCredits: integer(data.tokenStatsCredits),
    webSearchCount: integer(data.webSearchCount),
    successfulAiRequests: integer(data.successfulAiRequests),
    // Settle rows are negative amounts; the sign is kept for the caller's existing absolute value.
    settleCredits: integer(data.settleCredits, false),
    completedPaymentOrders: integer(data.completedPaymentOrders),
    completedPaymentAmount: integer(data.completedPaymentAmount),
    calls: {
      settledCalls: integer(calls.settledCalls),
      mismatched: integer(calls.mismatched),
      sample: list(calls.sample).map(String),
    },
    turns: {
      settledTurns: integer(turns.settledTurns),
      mismatched: integer(turns.mismatched),
      sample: list(turns.sample).map((item) => {
        const row = record(item);
        return { actorId: String(row.actorId), turnId: String(row.turnId) };
      }),
    },
    sources: {
      mismatched: integer(sources.mismatched),
      sample: list(sources.sample).map((item) => {
        const row = record(item);
        return { kind: String(row.kind), id: String(row.id) };
      }),
    },
    entries: { unattributed: integer(entries.unattributed), notApplied: integer(entries.notApplied) },
  };
}

// ARCH-FIX E2: each settled call's ledger rows sum to its charge less compensation; packs and subscription grants agree with
// the credit-source ledger. V2-12 R7: a settled turn's spend rows (and its not-returned freeze row) equal what the turn charged.
export function ledgerMismatches({ calls, turns, sources }: DailyBillingTotals): string[] {
  const out: string[] = [];
  if (calls.mismatched > 0) {
    out.push(`Call ledger rows do not match the charge for ${calls.mismatched} of ${calls.settledCalls} settled calls`
      + ` (${calls.sample.join(', ')})`);
  }
  if (turns.mismatched > 0) {
    out.push(`Turn ledger rows do not match the charge for ${turns.mismatched} of ${turns.settledTurns} settled turns`
      + ` (${turns.sample.map((row) => `${row.actorId}:${row.turnId}`).join(', ')})`);
  }
  if (sources.mismatched > 0) {
    const sample = sources.sample.map((row) => `${row.kind}:${row.id}`).join(', ');
    out.push(`Credit source ledgers disagree for ${sources.mismatched} sources (${sample})`);
  }
  return out;
}
