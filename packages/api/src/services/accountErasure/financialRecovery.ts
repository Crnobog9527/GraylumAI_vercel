/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BillingRpc } from '../turn/provider/frozenRun';
import { createRuntimeBudget, type RuntimeBudget } from '../turn/settings/budget';

// Only the counts and reasons are read. The items (old runs) are not settled from here any more: a run still open keeps the
// account in billing_pending until it is closed, and an open turn is closed by the turn recovery cron.
const batchSchema = z.object({
  totalPending: z.number().int().nonnegative(),
  oldestPendingAt: z.string().nullable(), reasons: z.record(z.string(), z.number()),
}).passthrough();
export type ErasureFinancialSummary = {
  success: boolean; processed: number; failed: number; pending: number;
  oldestPendingAt: string | null; reasons: Record<string, number>; durationMs: number;
};

/** The existing 60s cron reserves five seconds for response/shutdown. Confirmation
 * uses five seconds and never constructs a supplier adapter. No new schedule. */
export function erasureFinancialBudget(ms: number, now = () => performance.now()): RuntimeBudget {
  const base = createRuntimeBudget(now);
  const deadline = now() + ms;
  return { ...base, workDeadline: deadline - 2_000, persistenceDeadline: deadline,
    remainingPersistence: () => deadline - now(),
    assertCanPersist(duration = 0) {
      if (now() + duration >= deadline) throw new Error('ERASURE_FINANCIAL_BUDGET');
    },
    assertCanStart(duration = 0) {
      if (now() + duration >= deadline - 2_000) throw new Error('ERASURE_FINANCIAL_BUDGET');
    },
    modelCallTimeout() { throw new Error('RUNTIME_DISPATCH_DISABLED'); },
  };
}

export function boundedFinancialDatabase(admin: SupabaseClient, budget: RuntimeBudget): BillingRpc {
  return { rpc(name, args) {
    budget.assertCanPersist();
    return admin.rpc(name, args).abortSignal(AbortSignal.timeout(Math.max(1, Math.ceil(budget.remainingPersistence()))));
  } };
}

/** Inventory is service-only SQL authority, not a client-supplied identity list. Read-only count of what keeps erased accounts
 * from finishing (old runs not closed, turns open or settling); with a profile id the account's erasure status is noted. */
export async function recoverErasedAccounts(input: {
  database: BillingRpc; budget: RuntimeBudget; profileId?: string; now?: () => number;
}): Promise<ErasureFinancialSummary> {
  const now = input.now ?? Date.now;
  const started = now();
  const report: ErasureFinancialSummary = {
    success: false, processed: 0, failed: 0, pending: 0, oldestPendingAt: null, reasons: {}, durationMs: 0,
  };
  try {
    input.budget.assertCanPersist(500);
    const result = await input.database.rpc('account_erasure_financial_batch', {
      p_limit: 20, p_profile_id: input.profileId ?? null, p_after_run_id: null,
    });
    if (result.error) throw new Error('ERASURE_FINANCIAL_INVENTORY_FAILED');
    const batch = batchSchema.parse(result.data);
    report.pending = batch.totalPending;
    report.oldestPendingAt = batch.oldestPendingAt;
    report.reasons = batch.reasons;
    if (input.profileId) {
      const reason = Object.keys(batch.reasons).find(code => code !== 'BILLING_PENDING') ?? 'BILLING_PENDING';
      const noted = await input.database.rpc('account_erasure_note_error', {
        p_profile_id: input.profileId, p_code: report.pending === 0 ? 'BILLING_CLEAR' : reason,
      });
      if (noted.error) report.failed++;
    }
    report.success = report.failed === 0 && report.pending === 0;
  } catch { report.failed++; }
  report.durationMs = now() - started;
  return report;
}

export async function runErasureFinancialReconciliation(admin: SupabaseClient, budget = erasureFinancialBudget(55_000)) {
  return recoverErasedAccounts({ database: boundedFinancialDatabase(admin, budget), budget });
}

export async function closeErasedAccountFinancials(admin: SupabaseClient, profileId: string) {
  const budget = erasureFinancialBudget(5_000);
  return recoverErasedAccounts({ database: boundedFinancialDatabase(admin, budget), budget, profileId });
}
