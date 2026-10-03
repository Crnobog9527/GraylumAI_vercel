/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BillingRpc, BillingTransport } from '../bill2/service';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { finishOriginalFinancial } from '../runtime/inflightFinancial';
import { stagingTransport } from '../runtime/stagingTransport';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';
import type { StagingPolicy } from '../runtime/stagingPolicy';

const itemSchema = z.object({
  actorId: z.string().uuid(), executionId: z.string().uuid(), runId: z.string().uuid(),
  reason: z.string(), recoveryPolicy: z.unknown(),
});
const batchSchema = z.object({
  selectedActorId: z.string().uuid().nullable(), items: z.array(itemSchema).max(20),
  nextRunId: z.string().uuid().nullable(), totalPending: z.number().int().nonnegative(),
  oldestPendingAt: z.string().nullable(), reasons: z.record(z.string(), z.number()),
});
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

/** Inventory is service-only SQL authority, not a client-supplied identity list. */
export async function recoverErasedAccounts(input: {
  database: BillingRpc; budget: RuntimeBudget; profileId?: string;
  adapter?: (policy: unknown) => BillingTransport; now?: () => number;
}): Promise<ErasureFinancialSummary> {
  const now = input.now ?? Date.now;
  const started = now();
  const report: ErasureFinancialSummary = {
    success: false, processed: 0, failed: 0, pending: 0, oldestPendingAt: null, reasons: {}, durationMs: 0,
  };
  const note = async (actorId: string, code: string) => {
    const result = await input.database.rpc('account_erasure_note_error', { p_profile_id: actorId, p_code: code });
    if (result.error) report.failed++;
  };
  const inventory = async (actorId?: string, after?: string) => {
    input.budget.assertCanPersist(500);
    const result = await input.database.rpc('account_erasure_financial_batch', {
      p_limit: 20, p_profile_id: actorId ?? null, p_after_run_id: after ?? null,
    });
    if (result.error) throw new Error('ERASURE_FINANCIAL_INVENTORY_FAILED');
    return batchSchema.parse(result.data);
  };
  try {
    let actorId = input.profileId;
    let after: string | undefined;
    // Bounded pages, with stable run pagination; SQL excludes unprogressable rows
    // from work but includes them in pending counts/age. No unknown row monopolizes selection.
    for (let page = 0; page < 4; page++) {
      const batch = await inventory(actorId, after);
      report.pending = batch.totalPending;
      report.oldestPendingAt = batch.oldestPendingAt;
      report.reasons = batch.reasons;
      if (!batch.selectedActorId || !batch.items.length) break;
      actorId = batch.selectedActorId;
      for (const item of batch.items) {
        input.budget.assertCanPersist(500);
        if (item.actorId !== actorId) throw new Error('ERASURE_FINANCIAL_BINDING_FAILED');
        try {
          // Close every item before any network work; no provider call holds a DB lock.
          await finishOriginalFinancial({ database: input.database, actorId, executionId: item.executionId,
            budget: input.budget });
          report.processed++;
        } catch { report.failed++; await note(actorId, 'BILLING_RECOVERY_FAILED'); }
      }
      if (input.adapter) {
        for (const item of batch.items) {
          try { input.budget.assertCanStart(45_000); } catch { break; }
          try {
            await finishOriginalFinancial({ database: input.database, actorId, executionId: item.executionId,
              budget: input.budget, adapter: input.adapter(item.recoveryPolicy) });
          } catch { report.failed++; await note(actorId, 'BILLING_CREDENTIAL_UNAVAILABLE'); }
        }
      }
      const reason = batch.items.find(item => item.reason !== 'BILLING_PENDING')?.reason ?? 'BILLING_PENDING';
      await note(actorId, reason);
      if (batch.nextRunId) after = batch.nextRunId;
      else { if (input.profileId) break; actorId = undefined; after = undefined; }
    }
    const remaining = await inventory(input.profileId);
    report.pending = remaining.totalPending;
    report.oldestPendingAt = remaining.oldestPendingAt;
    report.reasons = remaining.reasons;
    if (input.profileId) {
      const reason = Object.keys(remaining.reasons).find(code => code !== 'BILLING_PENDING') ?? 'BILLING_PENDING';
      await note(input.profileId, report.pending === 0 ? 'BILLING_CLEAR' : reason);
    }
    report.success = report.failed === 0 && report.pending === 0;
  } catch { report.failed++; }
  report.durationMs = now() - started;
  return report;
}

export async function runErasureFinancialReconciliation(admin: SupabaseClient, budget = erasureFinancialBudget(55_000)) {
  return recoverErasedAccounts({ database: boundedFinancialDatabase(admin, budget), budget,
    adapter: policy => {
      // Retain original target/credential controls. An unavailable policy never prevents closing.
      stagingRuntimeWindow(process.env, true);
      return stagingTransport(admin, policy as StagingPolicy, budget);
    },
  });
}

export async function closeErasedAccountFinancials(admin: SupabaseClient, profileId: string) {
  const budget = erasureFinancialBudget(5_000);
  return recoverErasedAccounts({ database: boundedFinancialDatabase(admin, budget), budget, profileId });
}
