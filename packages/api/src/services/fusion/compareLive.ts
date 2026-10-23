/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc } from '../bill2/service';
import { readOpenRouterKey } from '../models/openRouterKey';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { newWorkGate, requireNewWork } from '../runtime/newWorkGate';
import { refusePositioning, windowBoundKey } from '../runtime/positioningGate';
import { runtimeGateEnvironment } from '../runtime/realHost';
import { runtimeActor } from '../runtime/actor';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { StagingAccessError } from '../runtime/stagingErrors';
import { adoptCompare } from './compareAdopt';
import { compareRpc } from './compareAdmission';
import { streamCompareColumn } from './compareColumn';
import { loadCompareChoice, type CompareRequestInput } from './compareLoad';
import { estimateCompare, startCompare, type CompareDeps, type CompareEstimate } from './compareStart';
import { fusionExecutor } from './executor';

/** What the live compare needs from the protected context (as the review's liveFlow). */
export type CompareCtx = { hasSupabaseAdminPrivileges?: boolean; supabaseAdmin?: SupabaseClient | null; user: { id: string };
  userScopedSupabase: SupabaseClient; runtimeBudget?: RuntimeBudget; headers?: Headers | null };

type ReadColumn = { column: number; runId: string; body: string | null;
  call: { callId: string; verdict: string | null; inFlight?: boolean; settled?: boolean } | null };

/** The compare view, after judging any column whose body was saved but whose verdict never got written (a crash between
 * the two): a compare answer has no format to check, so a saved body is usable, as it would have been uninterrupted. Needs
 * only the admin client, so a compare stays readable when the staging call window has closed; settling the judged run is
 * attempted through `settle` and otherwise left to the daily recovery (which settles judged calls). */
export async function readCompare(admin: SupabaseClient, actorId: string, compareId: string, settle?: () => Promise<(runId: string) => Promise<unknown>>) {
  const read = () => compareRpc<{ columns: ReadColumn[] } | null>(admin, 'fusion_compare_read', { p_actor_id: actorId, p_compare_id: compareId });
  const view = await read();
  if (!view) throw new Error('FUSION_COMPARE_DENIED');
  const unjudged = view.columns.filter(c => c.body !== null && c.call && c.call.verdict === null && !c.call.inFlight);
  if (!unjudged.length) return view;
  for (const column of unjudged) {
    await compareRpc(admin, 'fusion_call_verdict', { p_actor_id: actorId, p_call_id: column.call!.callId, p_verdict: 'usable' }).catch(() => undefined);
  }
  const settleRun = await settle?.().catch(() => undefined);
  if (settleRun) for (const column of unjudged) await settleRun(column.runId).catch(() => undefined);
  return read();
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
      return windowBoundKey(row?.data ?? null, await readOpenRouterKey(admin, { fresh: true }).catch(() => undefined), account);
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
    adopt: (input: { compareId: string; column: number; requestId: string }) => adoptCompare({ admin, actorId }, input),
  };
}
