/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import {throwIfContentErased} from '../accountErasure/content';
import type { SupabaseClient } from '@supabase/supabase-js';
/** SQL owns scope, history availability and the public result metadata whitelist. */
export async function readNativeRuntimeView(database: SupabaseClient, actorId: string, sessionId: string) {
  let data = await readView(database, actorId, sessionId);
  const check = await recheckSources(database, actorId, data.executions);
  if (check.reread) data = await readView(database, actorId, sessionId);
  for (const execution of data.executions as ViewedExecution[]) {
    if (check.hidden.has(execution.executionId)) { delete execution.body; delete execution.primaryBody; delete execution.summary; }
  }
  return data;
}
async function readView(database: SupabaseClient, actorId: string, sessionId: string) {
  const view = await database.rpc('runtime_view', { p_actor_id: actorId, p_session_id: sessionId });
  throwIfContentErased(view.error);
  // runtime_view raises this one refusal for another actor's, missing and
  // out-of-scope sessions alike, so the reply never reveals which one it was.
  if (view.error?.message === 'RUNTIME_SCOPE_DENIED') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'RUNTIME_SESSION_NOT_FOUND' });
  }
  if (view.error || !view.data || view.data.sessionId !== sessionId || !Array.isArray(view.data.executions)) {
    throw new Error('RUNTIME_VIEW_DENIED');
  }
  return view.data;
}

type ViewedExecution = { executionId?: unknown; state?: unknown; unavailableReason?: unknown;
  body?: unknown; primaryBody?: unknown; summary?: unknown };
/**
 * LIB-4b: a paused or cost-pending round may already show a saved body (a PAYG primary checkpoint). Reading it applies
 * the 0262 entry check, which marks a round whose referenced document was deleted (the view is then read once more);
 * a round whose document changed version, or whose state cannot be read, keeps its row but shows no body (fail closed).
 * Only these states are read: unlike a running round, their read has no side effect besides that mark.
 */
async function recheckSources(database: SupabaseClient, actorId: string, executions: ViewedExecution[]) {
  const hidden = new Set<unknown>();let reread = false;
  const shown = executions.filter(e => ['waiting_credits', 'waiting_resume', 'cost_pending'].includes(String(e.state))
    && !e.unavailableReason && (e.body != null || e.primaryBody != null || e.summary != null));
  for (const { executionId } of shown) {
    const read = await database.rpc('runtime_execution', { p_actor_id: actorId, p_execution_id: executionId, p_action: 'read' });
    throwIfContentErased(read.error);
    const data = read.data as { unavailableReason?: unknown; context?: { libraryReferences?: unknown } } | null;
    if (read.error || !data) { hidden.add(executionId); continue; }
    if (data.unavailableReason === 'source_deleted') { reread = true; continue; }
    if (!Array.isArray(data.context?.libraryReferences) || !data.context.libraryReferences.length) continue;
    const live = await database.rpc('runtime_library_visible',
      { p_actor_id: actorId, p_execution_id: executionId, p_result: { kind: 'library_index' } });
    if (live.error || live.data !== true) hidden.add(executionId);
  }
  return { reread, hidden };
}
