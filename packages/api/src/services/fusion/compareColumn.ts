/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPositioningRefusal } from '../runtime/positioningFallback';
import { compareRpc, replayCompareGroup } from './compareAdmission';
import { columnStreamer } from './compareStream';
import type { FusionCallOutcome, FusionClaimedCall, ExecutableRun, FusionBodyVerdict } from './executor';

/** One column of a compare, one browser request (FUSION-COMPARE §3.5): the page asks for each column on its own so a failure
 * or timeout of one never touches another, and a refresh can ask again. */
export type ColumnEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; verdict: FusionBodyVerdict | 'no_delivery' }
  /** Nothing more can be known now (receipt not in, response unreadable, closed): the read shows the settled state later. */
  | { type: 'pending'; reason: string }
  /** The column was already dispatched or judged by an earlier request; the page reads it instead of streaming. */
  | { type: 'already'; verdict: string | null };

type ReadColumn = { column: number; runId: string; call: { callId: string; state: string; dispatched: boolean; verdict: string | null } | null;
  body: string | null };
type ReadView = { compareId: string; requestId: string; sessionId: string; state: string; gateFallback: boolean | null; columns: ReadColumn[] };

export type ColumnDeps = { admin: SupabaseClient; actorId: string;
  executor: { run(run: ExecutableRun, claimed: FusionClaimedCall, judge: (text: string) => FusionBodyVerdict,
    onChunk?: (chunk: string) => void, refuse?: (text: string) => boolean): Promise<FusionCallOutcome> } };

/** Dispatches the column once. A repeat while the first request runs, or after it ended, never dispatches again: it returns
 * `already` (the database also refuses a second dispatch of the same call). Rate limit, time budget and holds are the
 * executor's, as for every Fusion call. */
export async function* streamCompareColumn(deps: ColumnDeps, input: { compareId: string; column: number }): AsyncGenerator<ColumnEvent> {
  const view = await compareRpc<ReadView | null>(deps.admin, 'fusion_compare_read', { p_actor_id: deps.actorId, p_compare_id: input.compareId });
  if (!view) throw new Error('FUSION_COMPARE_DENIED');
  if (!['running', 'finished'].includes(view.state)) throw new Error('FUSION_COMPARE_ENDED');
  const column = view.columns.find(candidate => candidate.column === input.column);
  if (!column?.call) throw new Error('FUSION_COMPARE_DENIED');
  if (column.call.dispatched || column.call.verdict !== null || column.body !== null) {
    yield { type: 'already', verdict: column.call.verdict };
    return;
  }
  const group = await replayCompareGroup(deps.admin, deps.actorId, view.requestId, view.sessionId);
  const run = group?.runs.find(candidate => candidate.index === input.column && candidate.runId === column.runId);
  if (!run) throw new Error('FUSION_COMPARE_DENIED');
  // One request owns the dispatch of a column: an exclusive claim in the database, taken before the executor is entered (its
  // call-gate unit and its refusal path belong to the owner only). A request that lost, or a column claimed a moment ago by a
  // tab that is dispatching it, answers `already`: the page reads the column instead of streaming it.
  const owner = await compareRpc<boolean>(deps.admin, 'fusion_compare_dispatch_claim', { p_actor_id: deps.actorId, p_call_id: column.call.callId });
  if (owner !== true) { yield { type: 'already', verdict: null }; return; }

  // A column admitted with the positioning fallback rule may answer with the marker instead of an answer: held back and
  // refused before saving, so it is never shown, never saved and never charged.
  const hold = view.gateFallback === true;
  const queue: ColumnEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown;
  const push = (event: ColumnEvent) => { queue.push(event); wake?.(); };
  const streamer = columnStreamer({ holdForRefusal: hold, emit: text => push({ type: 'delta', text }) });
  const task = deps.executor.run(run, { runId: run.runId, id: column.call.callId, state: column.call.state, fresh: false },
    () => 'usable', streamer.onChunk, hold ? isPositioningRefusal : undefined)
    .then(async outcome => {
      // The connection was confirmed never started (the call is back to prepared): give the claim back so a retry can
      // dispatch within the call's dispatch window instead of waiting out the lease.
      if (outcome.state === 'pending' && outcome.reason === 'not_started') {
        await compareRpc(deps.admin, 'fusion_compare_dispatch_release', { p_actor_id: deps.actorId, p_call_id: column.call!.callId }).catch(() => undefined);
      }
      streamer.settle(outcome.state === 'judged' && outcome.verdict === 'no_delivery' && hold && isPositioningRefusal(streamer.text()));
      push(outcome.state === 'judged' ? { type: 'done', verdict: outcome.verdict } : { type: 'pending', reason: outcome.reason });
    })
    .catch(async error => {
      failure = error;
      // Setup threw before anything was sent (the call is still prepared): give the claim back so a retry can dispatch. The
      // database refuses to release a call that was dispatched or settled, so this is safe on every exception path.
      await compareRpc(deps.admin, 'fusion_compare_dispatch_release', { p_actor_id: deps.actorId, p_call_id: column.call!.callId }).catch(() => undefined);
    })
    .finally(() => { finished = true; wake?.(); });
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>(resolve => { wake = resolve; });
    wake = null;
  }
  await task;
  while (queue.length) yield queue.shift()!;
  if (failure) throw failure;
}
