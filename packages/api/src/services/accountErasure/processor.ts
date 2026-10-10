/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { erasureRpcDiagnostic } from './rpcDiagnostics';
import type { BillingRpc } from '../bill2/service';
import {
  batchSchema, beginSchema, contentRemaining, detachSchema, financialSchema, localSchema,
  recoverySchema, resultSchema, storageReadySchema, storageSchema, workSchema,
} from './processorContracts';

export interface ErasureStorageAdapter {
  cleanSubject(profileId: string): Promise<{ complete: boolean; remaining: number; manualReview: number }>;
}
export interface ErasureAuthAdapter {
  getState(profileId: string): Promise<'present' | 'absent' | 'unknown'>;
  remove(profileId: string): Promise<void>;
}
export type ErasureProcessResult = {
  stage: 'closed' | 'erasing' | 'billing_pending' | 'completed'; retry: boolean;
  remaining: number; manualReview: number; errorCodes: string[];
};
type Input = {
  profileId: string; database: BillingRpc; storageAdapter: ErasureStorageAdapter; authAdapter: ErasureAuthAdapter;
  /** Local execution bounds only. There is no scheduler, provider adapter, or production entry point. */
  budget?: { now?: () => number; deadline?: number; maxPages?: number; operationTimeoutMs?: number; storagePassTimeoutMs?: number };
};
class ProcessorFault extends Error {}

/** One closed subject, separate RPC transactions, bounded pages. Injected adapters own their actual I/O. */
export async function processAccountErasure(input: Input): Promise<ErasureProcessResult> {
  const report: ErasureProcessResult = { stage: 'erasing', retry: true, remaining: 0, manualReview: 0, errorCodes: [] };
  const now = input.budget?.now ?? Date.now;
  const deadline = input.budget?.deadline ?? now() + 30_000;
  const pages = input.budget?.maxPages ?? 4;
  const timeout = input.budget?.operationTimeoutMs ?? 2_000;
  const storageTimeout = input.budget?.storagePassTimeoutMs ?? timeout;
  const error = (code: string) => { if (!report.errorCodes.includes(code)) report.errorCodes.push(code); };
  if (!z.string().uuid().safeParse(input.profileId).success || !Number.isFinite(deadline)
    || !Number.isInteger(storageTimeout) || storageTimeout < 1 || storageTimeout > 55_000
    || !Number.isInteger(pages) || pages < 1 || pages > 4 || !Number.isInteger(timeout) || timeout < 1 || timeout > 5_000) {
    error('ERASURE_INVALID_INPUT'); report.remaining = 1; return report;
  }
  let calls = 0;
  let databaseUncertain = false;
  let requestId: string | undefined;
  const bounded = async <T>(operation: () => PromiseLike<T>, operationBudget = timeout): Promise<T> => {
    if (++calls > 600 || now() >= deadline) throw new ProcessorFault('ERASURE_BUDGET_EXHAUSTED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProcessorFault('ERASURE_OPERATION_TIMEOUT')), Math.min(operationBudget, deadline - now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (databaseUncertain) throw new ProcessorFault('ERASURE_RPC_UNCERTAIN');
    let sent = false;
    try {
      const response = await bounded(() => { sent = true; return input.database.rpc(name, args); });
      if (!response || response.error) {
        error(erasureRpcDiagnostic(name, response?.error));
        throw new ProcessorFault('ERASURE_RPC_FAILED');
      }
      return response.data;
    } catch (caught) {
      // A transport rejection (including SDK error results) may arrive after commit. No further DB/Auth mutation this pass.
      if (sent) {
        databaseUncertain = true;
        if (!(caught instanceof ProcessorFault) || caught.message === 'ERASURE_OPERATION_TIMEOUT') {
          error(erasureRpcDiagnostic(name, null, caught instanceof ProcessorFault ? 'timeout' : 'transport'));
        }
      }
      throw caught instanceof ProcessorFault ? caught : new ProcessorFault('ERASURE_RPC_UNCERTAIN');
    }
  };
  const actor = { p_profile_id: input.profileId };
  const inventory = async (after: string | null = null) => {
    const value = workSchema.parse(await rpc('account_erasure_work_batch', {
      ...actor, p_limit: 20, p_after_run_id: after,
    }));
    if (requestId && requestId !== value.requestId) throw new ProcessorFault('ERASURE_IDENTITY_CHANGED');
    requestId = value.requestId;
    if (new Set(value.runs).size !== value.runs.length || (value.nextRunId !== null && !value.runs.includes(value.nextRunId))) {
      throw new ProcessorFault('ERASURE_INVALID_RESULT');
    }
    return value;
  };
  const batch = (value: unknown) => {
    const parsed = batchSchema.parse(value);
    report.remaining += parsed.remaining; report.manualReview += parsed.manualReview ?? 0;
    if (parsed.reason && parsed.reason !== 'no_runtime_binding') error('ERASURE_CONTENT_PENDING');
    return parsed;
  };
  const attempt = async (operation: () => Promise<void>) => {
    try { await operation(); } catch (caught) {
      report.remaining++;
      error(caught instanceof ProcessorFault ? caught.message : 'ERASURE_INVALID_RESULT');
    }
  };
  try {
    let work = await inventory();
    const runs: Array<{ id: string; terminal: boolean }> = [];
    const seen = new Set<string>();
    for (let page = 0; page < pages; page++) {
      for (const id of work.runs) {
        if (seen.has(id)) throw new ProcessorFault('ERASURE_INVALID_RESULT');
        seen.add(id);
        await attempt(async () => {
          const binding = { p_actor_id: input.profileId, p_run_id: id };
          const cancelled = financialSchema.parse(await rpc('bill2_cancel', binding));
          if (cancelled.id !== id) throw new ProcessorFault('ERASURE_IDENTITY_CHANGED');
          const settled = financialSchema.parse(await rpc('bill2_finalize', binding));
          if (settled.id !== id) throw new ProcessorFault('ERASURE_IDENTITY_CHANGED');
          const view = financialSchema.parse(await rpc('bill2_read', binding));
          if (view.id !== id) throw new ProcessorFault('ERASURE_IDENTITY_CHANGED');
          if (view.executionId) {
            const recovered = recoverySchema.parse(await rpc('runtime_financial_recovery', {
              p_actor_id: input.profileId, p_execution_id: view.executionId, p_finish: true,
            }));
            if (recovered.executionId !== view.executionId || recovered.runId !== id) throw new ProcessorFault('ERASURE_IDENTITY_CHANGED');
            if (!['completed', 'cancelled'].includes(recovered.state)) report.remaining++;
          }
          const terminal = ['settled', 'refunded'].includes(settled.state) && ['settled', 'refunded'].includes(view.state);
          if (!terminal) { report.remaining++; report.stage = 'billing_pending'; }
          runs.push({ id, terminal });
        });
      }
      if (!work.nextRunId) break;
      if (page === pages - 1) { report.remaining++; error('ERASURE_PAGE_LIMIT'); break; }
      work = await inventory(work.nextRunId);
    }
    for (const name of ['account_erasure_scrub_content', 'account_erasure_scrub_runtime']) {
      await attempt(async () => {
        const content = contentRemaining(await rpc(name, actor));
        report.remaining += content.remaining;
        if (content.retry) error('ERASURE_CONTENT_PENDING');
      });
    }
    for (const run of runs) {
      for (const name of ['account_erasure_scrub_receipts', 'account_erasure_scrub_run', 'account_erasure_scrub_calls']) {
        await attempt(async () => {
          batch(await rpc(name, { ...actor, p_run_id: run.id, ...(name.endsWith('receipts') ? { p_limit: 100 } : {}) }));
        });
      }
      if (run.terminal) await attempt(async () => {
        const detached = detachSchema.parse(await rpc('account_erasure_detach_runtime', { ...actor, p_run_id: run.id }));
        if (!('detached' in detached)) batch(detached);
      });
    }
    for (const [name, tables] of [
      ['account_erasure_scrub_ledger', ['credit_transactions', 'billing_history', 'token_stats', 'ai_usage_logs']],
      ['account_erasure_scrub_payment', ['payment_orders', 'user_subscriptions', 'subscription_credit_grants']],
    ] as const) {
      for (const table of tables) await attempt(async () => {
        let after: string | null = null;
        const cursors = new Set<string>();
        let remaining = 0;
        for (let page = 0; page < pages; page++) {
          const result = batchSchema.extend({ manualReview: z.number().int().nonnegative(),
            nextRowId: z.string().uuid().nullable() }).parse(await rpc(name, { ...actor, p_table: table, p_limit: 100, p_after_id: after }));
          report.manualReview += result.manualReview; remaining = result.remaining;
          if (!remaining || !result.nextRowId) break;
          if (cursors.has(result.nextRowId)) throw new ProcessorFault('ERASURE_INVALID_RESULT');
          cursors.add(result.nextRowId); after = result.nextRowId;
        }
        report.remaining += remaining;
      });
    }
    // Financial uncertainty must not postpone unrelated private-content cleanup.
    const current = await inventory();
    report.remaining += current.financialPending; report.manualReview += current.manualReview;
    if (current.financialPending || current.manualReview) report.stage = 'billing_pending';
    let storageVerified = false;
    await attempt(async () => {
      const admission = storageReadySchema.parse(await rpc('account_erasure_storage_ready', actor));
      if (!admission.ready) { report.remaining++; error('ERASURE_STORAGE_PENDING'); return; }
      const storage = storageSchema.parse(await bounded(() => input.storageAdapter.cleanSubject(input.profileId), storageTimeout));
      storageVerified = storage.complete && storage.remaining === 0 && storage.manualReview === 0;
      report.remaining += storage.remaining; report.manualReview += storage.manualReview;
      if (!storageVerified) { report.remaining = Math.max(1, report.remaining); error('ERASURE_STORAGE_PENDING'); }
    });
    const local = localSchema.parse(await rpc('account_erasure_local_cleanup', { ...actor, p_storage_verified: storageVerified }));
    report.remaining += local.remaining; report.manualReview += local.manualReview;
    if (report.manualReview) report.stage = 'billing_pending';
    if (local.errors.length) { error('ERASURE_LOCAL_PENDING'); report.remaining = Math.max(1, report.remaining); }
    if (report.remaining || report.manualReview || report.errorCodes.length || !storageVerified) return report;
    const begin = beginSchema.parse(await rpc('account_erasure_auth_begin', { ...actor, p_request_id: requestId }));
    if (begin.requestId !== requestId || (begin.claimed && (!begin.started || !begin.ready || begin.alreadyDeleted))) {
      throw new ProcessorFault('ERASURE_IDENTITY_CHANGED');
    }
    if (!begin.ready) { report.remaining = 1; error('ERASURE_AUTH_NOT_READY'); return report; }
    // Always read the exact original Auth identity. A resumed intent never sends another deletion.
    let authState = z.enum(['present', 'absent', 'unknown']).parse(await bounded(() => input.authAdapter.getState(input.profileId)));
    if (authState === 'present' && begin.claimed) {
      try { await bounded(() => input.authAdapter.remove(input.profileId)); } catch { /* Read back even after uncertain removal. */ }
      authState = z.enum(['present', 'absent', 'unknown']).parse(await bounded(() => input.authAdapter.getState(input.profileId)));
    }
    if (authState !== 'absent') { report.remaining = 1; error('ERASURE_AUTH_PENDING'); return report; }
    const result = resultSchema.parse(await rpc('account_erasure_auth_result', {
      ...actor, p_request_id: requestId, p_absent: true,
    }));
    report.stage = result.stage;
    if (result.stage !== 'completed') { report.remaining = 1; error('ERASURE_AUTH_PENDING'); return report; }
    report.retry = false;
  } catch (caught) {
    report.remaining = Math.max(1, report.remaining);
    error(caught instanceof ProcessorFault ? caught.message : 'ERASURE_INVALID_RESULT');
  }
  return report;
}
