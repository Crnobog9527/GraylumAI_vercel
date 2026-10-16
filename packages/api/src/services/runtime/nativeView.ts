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
 * LIB-4b: an unfinished round may already show a saved body (a PAYG or organizer primary checkpoint). A paused or
 * cost-pending round is read through runtime_execution, whose 0262 entry check marks a deleted source (the view is then
 * read once more). A running round is never read that way (its read may pause it); a read-only probe tells whether it
 * froze references. Any round whose referenced document is deleted or changed, or whose state cannot be confirmed,
 * keeps its row but shows no body (fail closed).
 */
async function recheckSources(database: SupabaseClient, actorId: string, executions: ViewedExecution[]) {
  const hidden = new Set<unknown>();let reread = false;
  const shown = executions.filter(e => ['running', 'waiting_credits', 'waiting_resume', 'cost_pending'].includes(String(e.state))
    && !e.unavailableReason && (e.body != null || e.primaryBody != null || e.summary != null));
  for (const { executionId, state } of shown) {
    const referenced = state === 'running' ? await probeReferences(database, actorId, executionId)
      : await readReferences(database, actorId, executionId);
    if (referenced === 'deleted') reread = true;
    else if (referenced === 'unknown') hidden.add(executionId);
    else if (referenced) {
      const live = await database.rpc('runtime_library_visible',
        { p_actor_id: actorId, p_execution_id: executionId, p_result: { kind: 'library_index' } });
      if (live.error || live.data !== true) hidden.add(executionId);
    }
  }
  return { reread, hidden };
}
async function readReferences(database: SupabaseClient, actorId: string, executionId: unknown) {
  const read = await database.rpc('runtime_execution', { p_actor_id: actorId, p_execution_id: executionId, p_action: 'read' });
  throwIfContentErased(read.error);
  const data = read.data as { unavailableReason?: unknown; context?: { libraryReferences?: unknown } } | null;
  if (read.error || !data) return 'unknown' as const;
  if (data.unavailableReason === 'source_deleted') return 'deleted' as const;
  return Array.isArray(data.context?.libraryReferences) && data.context.libraryReferences.length > 0;
}
/** runtime_library_read (0262) only reads: for a running round with frozen references the out-of-range "doc-0" answers
 * {kind:'unavailable'} without touching any document; without references it refuses with LIB_REFERENCE_READ_DENIED. */
async function probeReferences(database: SupabaseClient, actorId: string, executionId: unknown) {
  const probe = await database.rpc('runtime_library_read', { p_actor_id: actorId, p_execution_id: executionId, p_query: 'doc-0' });
  if (probe.error?.message === 'LIB_REFERENCE_READ_DENIED') return false;
  return probe.error || (probe.data as { kind?: unknown } | null)?.kind !== 'unavailable' ? 'unknown' as const : true;
}
