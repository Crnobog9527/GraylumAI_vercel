/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc } from '../bill2/service';
import { readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { newWorkGate, requireNewWork } from '../runtime/newWorkGate';
import { refusePositioning, windowBoundKey } from '../runtime/positioningGate';
import { runtimeGateEnvironment } from '../runtime/realHost';
import { runtimeActor } from '../runtime/actor';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { StagingAccessError } from '../runtime/stagingErrors';
import { compareRpc } from './compareAdmission';
import { streamCompareColumn } from './compareColumn';
import { loadCompareChoice, type CompareRequestInput } from './compareLoad';
import { estimateCompare, startCompare, type CompareDeps, type CompareEstimate } from './compareStart';
import { fusionExecutor } from './executor';
import { logSwallowed, swallow } from '../../lib/swallow';

/** What the live compare needs from the protected context (as the review's liveFlow). */
export type CompareCtx = { hasSupabaseAdminPrivileges?: boolean; supabaseAdmin?: SupabaseClient | null; user: { id: string };
  userScopedSupabase: SupabaseClient; runtimeBudget?: RuntimeBudget; headers?: Headers | null };

type ReadColumn = { column: number; runId: string; body: string | null;
  call: { callId: string; verdict: string | null; inFlight?: boolean; settled?: boolean } | null };

/** The compare view, after judging any column whose body was saved but whose verdict never got written (a crash between
 * the two): a compare answer has no format to check, so a saved body is usable, as it would have been uninterrupted. Needs
 * only the admin client, so a compare stays readable when the staging call window has closed; settling a judged run is
 * attempted through `settle`. A settlement that fails is never answered as done: it is logged, its run is listed in
 * `settlementPending`, and the call stays dispatched and unsettled, which is exactly what the daily recovery
 * (fusion_pending_financial_batch → recoverFusionFinancials) settles; the page shows such a column as "积分结算中". */
export async function readCompare(admin: SupabaseClient, actorId: string, compareId: string, settle?: () => Promise<(runId: string) => Promise<unknown>>):
  Promise<{ columns: ReadColumn[]; settlementPending?: string[] } | null> {
  const read = () => compareRpc<{ columns: ReadColumn[] } | null>(admin, 'fusion_compare_read', { p_actor_id: actorId, p_compare_id: compareId });
  const view = await read();
  if (!view) throw new Error('FUSION_COMPARE_DENIED');
  const unjudged = view.columns.filter(c => c.body !== null && c.call && c.call.verdict === null);
  // `inFlight` only means dispatched, unsettled and before the recovery deadline, not that a writer is still running, so it
  // is no signal to skip on: a verdict write is row-locked and idempotent for the same verdict, and settling twice is a no-op,
  // so repairing beside a writer that is just finishing is safe.
  if (!unjudged.length) return view;
  // Only a column whose verdict was written may settle: settling one that is still unjudged would close its run as stopped and
  // charge a saved answer that can then never be adopted. A failed repair stays open for the daily recovery.
  const judged: ReadColumn[] = [];
  for (const column of unjudged) {
    const done = await compareRpc(admin, 'fusion_call_verdict', { p_actor_id: actorId, p_call_id: column.call!.callId, p_verdict: 'usable' })
      .then(() => true, error => { logSwallowed('fusion_compare_verdict_repair_failed', error, { category: 'billing', compareId }); return false; });
    if (done) judged.push(column);
  }
  if (!judged.length) return read();
  const settleRun = settle ? await swallow('fusion_compare_settle_unavailable', settle(), undefined, { category: 'billing', compareId }) : undefined;
  const pending: string[] = [];
  for (const column of judged) {
    const settled = settleRun && await settleRun(column.runId).then(() => true,
      error => { logSwallowed('fusion_compare_settle_failed', error, { category: 'billing', compareId }); return false; });
    if (!settled) pending.push(column.runId);
  }
  const after = await read();
  return pending.length && after ? { ...after, settlementPending: pending } : after;
}

/** Stop the whole compare or one column: the database cancels and settles, no provider call is needed. */
export async function stopCompare(admin: SupabaseClient, actorId: string, input: { compareId: string; column?: number }) {
  let runId: string | null = null;
  if (input.column !== undefined) {
    const view = await compareRpc<{ columns: ReadColumn[] } | null>(admin, 'fusion_compare_read', { p_actor_id: actorId, p_compare_id: input.compareId });
    runId = view?.columns.find(c => c.column === input.column)?.runId ?? null;
    if (!runId) throw new Error('FUSION_COMPARE_DENIED');
  }
  return compareRpc<unknown>(admin, 'fusion_compare_stop', { p_actor_id: actorId, p_compare_id: input.compareId, p_run_id: runId });
}

/** The live compare for one request: the staging test window, billing, the Fusion executor and the call gate. */
export async function liveCompare(ctx: CompareCtx) {
  if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
  const admin = ctx.supabaseAdmin;
  const actorId = ctx.user.id;
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, process.env);
  const budget = ctx.runtimeBudget ?? createRuntimeBudget();
  const actor = runtimeActor(ctx.userScopedSupabase.auth, actorId, budget, ctx.headers?.get('Authorization'));
  const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor, adapter: stagingTransport(admin, window, budget), budget });
  const gate = newWorkGate(admin, runtimeGateEnvironment(window));
  const executor = fusionExecutor({ billing, admin, actorId, callGate: gate.calls, budget });

  const deps = (modelIds: string[]): CompareDeps => ({ admin, actorId, refusePositioning,
    // The window-bound platform key serves Decisions only, as for an ordinary turn; unreadable means "unavailable".
    decisionsKey: async () => {
      const first = modelIds[0];
      const row = first ? await admin.from('ai_models').select('provider,api_endpoint').eq('id', first).maybeSingle() : null;
      const account = window.callPolicies.find(policy => policy.modelId === first)?.account;
      return windowBoundKey(row?.data ?? null, await readOpenRouterKeyOrUnset(admin, { fresh: true }), account);
    },
    rateLimit: async () => requireNewWork(await gate.message(actorId)) });
  const choose = (input: CompareRequestInput) => loadCompareChoice({ admin, user: ctx.userScopedSupabase, actorId }, input);

  return {
    estimate: async (input: CompareRequestInput): Promise<CompareEstimate> => estimateCompare(deps(input.modelIds), await choose(input)),
    start: async (input: CompareRequestInput & { requestId: string; shown: Pick<CompareEstimate, 'credits' | 'columns'> }) =>
      startCompare(deps(input.modelIds), { ...await choose(input), requestId: input.requestId, shown: input.shown }),
    stream: (input: { compareId: string; column: number }) => streamCompareColumn({ admin, actorId, executor }, input),
    /** Settles a run whose only call was just judged (read after an interruption). */
    settle: (runId: string) => executor.settleJudged(runId),
  };
}
