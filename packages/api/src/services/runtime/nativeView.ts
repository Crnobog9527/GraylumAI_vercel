/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import {throwIfContentErased} from '../accountErasure/content';
import type { SupabaseClient } from '@supabase/supabase-js';
/** SQL owns scope, history availability and the public result metadata whitelist. */
export async function readNativeRuntimeView(database: SupabaseClient, actorId: string, sessionId: string) {
  const data = await readView(database, actorId, sessionId);
  const hidden = await sourceBoundBodies(database, actorId, data.executions);
  for (const execution of data.executions as ViewedExecution[]) {
    if (hidden.has(execution.executionId)) { delete execution.body; delete execution.primaryBody; delete execution.summary; }
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
 * LIB-4b: an unfinished round may already show a saved body (a PAYG or organizer primary checkpoint, an interrupted
 * round). Once a document it referenced is deleted (a newer version is not a deletion), that body is not shown, at once
 * and before any cleanup. One read-only query answers for every such round; if it fails, they show no body (fail
 * closed). Completed and cancelled answers stay as D7 keeps them; a round marked source_deleted never shows one.
 */
async function sourceBoundBodies(database: SupabaseClient, actorId: string, executions: ViewedExecution[]) {
  const shown = executions.filter(e => Boolean(e.body || e.primaryBody || e.summary));
  const hidden = new Set<unknown>(shown.filter(e => e.unavailableReason === 'source_deleted').map(e => e.executionId));
  const unfinished = shown.filter(e => !['completed', 'cancelled'].includes(String(e.state)) && !hidden.has(e.executionId))
    .map(e => e.executionId);
  if (!unfinished.length) return hidden;
  const gone = await database.rpc('runtime_library_sources_gone', { p_actor_id: actorId, p_execution_ids: unfinished });
  if (gone.error || !Array.isArray(gone.data)) return new Set([...hidden, ...unfinished]);
  for (const id of gone.data) hidden.add(id);
  return hidden;
}
