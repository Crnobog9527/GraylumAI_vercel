/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { BillingRpc, BillingTransport } from '../bill2/service';
import type { RuntimeBudget } from './budget';
import { runtimeExecutor } from './execute';
import { denyNewCalls } from './newWorkGate';

/** A lookup-only host. No SDK execution or new call capability escapes this module. */
export async function finishOriginalFinancial(input: {
  database: BillingRpc; actorId: string; executionId: string;
  budget: RuntimeBudget; adapter?: BillingTransport;
}) {
  const args = { p_actor_id: input.actorId, p_execution_id: input.executionId };
  // Close first. Lookup failure must not leave the call set or activity pointer open.
  const closed = await input.database.rpc('runtime_financial_recovery', { ...args, p_finish: true });
  if (closed.error) {
    const code = typeof closed.error === 'object' && 'message' in closed.error
      && closed.error.message === 'RUNTIME_EXECUTION_STILL_ALLOWED'
      ? 'RUNTIME_EXECUTION_STILL_ALLOWED' : 'ERASURE_FINANCIAL_BINDING_OR_STORAGE_FAILED';
    throw new Error(code);
  }
  const state = closed.data as { state: string; runId: string };
  if (state.state !== 'cost_pending' || !input.adapter) return state;
  try {
    input.budget.assertCanStart(45_000);
    const adapter: BillingTransport = {
      dispatch: async () => { throw new Error('RUNTIME_DISPATCH_DISABLED'); },
      lookup: input.adapter.lookup,
    };
    return await runtimeExecutor({ database: input.database, actor: async () => input.actorId,
      budget: input.budget, adapter, callGate: denyNewCalls }).recoverFinancial(input.executionId);
  } catch {
    // The authorized close already succeeded. Report pending, never pretend lookup settled it.
    const read = await input.database.rpc('runtime_financial_recovery', { ...args, p_finish: true });
    if (read.error) throw new Error('ERASURE_FINANCIAL_FINISH_FAILED');
    return read.data as typeof state;
  }
}

/** Original invocation only. A successful SQL dispatch establishes the financial binding;
 * neither browser input nor a failed/rotated dispatch can establish it. Business Auth stays intact. */
export function inflightFinancialHost(input: {
  database: BillingRpc; actorId: string; executionId: string; actor: () => Promise<string>; budget: RuntimeBudget;
}) {
  let runId: string | undefined;
  let admittedRunId: string | undefined;
  const calls = new Set<string>();
  let accountClosed = false;
  const database: BillingRpc = {
    rpc(name, args) {
      const query = input.database.rpc(name, args);
      const observe = (response: { data: unknown; error: unknown }) => {
      if (response.error || args.p_actor_id !== input.actorId) return response;
      const data = response.data as Record<string, unknown> | null;
      if (name === 'runtime_execution' && args.p_execution_id === input.executionId
        && data?.executionId === input.executionId && typeof data.runId === 'string') admittedRunId = data.runId;
      if (name === 'bill2_dispatch' && data?.dispatch === true && typeof args.p_run_id === 'string'
        && typeof args.p_call_id === 'string' && admittedRunId === args.p_run_id && (!runId || runId === args.p_run_id)) {
        runId = args.p_run_id;
        calls.add(args.p_call_id);
      }
      if (name === 'bill2_record' && args.p_run_id === runId && calls.has(String(args.p_call_id))
        && data?.accountClosed === true) accountClosed = true;
      return response;
      };
      const pending = Promise.resolve(query).then(observe);
      return Object.assign(pending, { abortSignal(signal: AbortSignal) {
        query.abortSignal?.(signal);
        return pending;
      } });
    },
  };
  return {
    database,
    async finish(adapter?: BillingTransport) {
      if (!runId) return undefined;
      try {
        const result = await finishOriginalFinancial({ ...input, adapter });
        const view = result as { billing?: { accountClosed?: boolean } };
        if (view.billing?.accountClosed) {
          accountClosed = true;
          const inventory = await input.database.rpc('account_erasure_financial_batch', {
            p_limit: 1, p_profile_id: input.actorId, p_after_run_id: null,
          });
          if (!inventory.error && inventory.data && typeof inventory.data === 'object') {
            const summary = inventory.data as { totalPending: number; reasons: Record<string, number> };
            const code = summary.totalPending === 0 ? 'BILLING_CLEAR'
              : Object.keys(summary.reasons).find(key => key !== 'BILLING_PENDING') ?? 'BILLING_PENDING';
            await input.database.rpc('account_erasure_note_error', { p_profile_id: input.actorId, p_code: code });
          }
        }
        return result;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'RUNTIME_EXECUTION_STILL_ALLOWED') return undefined;
        // Logout/password revocation leaves profiles active. Only the original dispatched
        // invocation can cancel after explicit Auth rejection only; transient Auth errors
        // preserve the execution for recovery and never grant new-call authority.
        try { await input.actor(); return undefined; } catch (authError) {
          if (!(authError instanceof Error) || authError.message !== 'RUNTIME_DENIED') return undefined;
        }
        const cancelled = await input.database.rpc('runtime_cancel', { p_actor_id: input.actorId, p_execution_id: input.executionId });
        if (cancelled.error) return undefined;
        try { return await finishOriginalFinancial({ ...input, adapter }); } catch { return undefined; }
      }
    },
    isAccountClosed: () => accountClosed,
  };
}
