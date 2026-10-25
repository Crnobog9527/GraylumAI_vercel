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
  const calls = record(data.calls), sources = record(data.sources), entries = record(data.entries);
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
