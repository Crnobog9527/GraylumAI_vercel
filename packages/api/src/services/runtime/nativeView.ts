/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import {throwIfContentErased} from '../accountErasure/content';
import type { SupabaseClient } from '@supabase/supabase-js';
/** SQL owns scope, history availability and the public result metadata whitelist. */
export async function readNativeRuntimeView(database: SupabaseClient, actorId: string, sessionId: string) {
  const data = await readView(database, actorId, sessionId);
  // LIB-4b: an unfinished round may already show a saved body (a PAYG round waiting after its primary checkpoint).
  // Reading it applies the 0262 entry check, which marks a round whose referenced document was deleted; the view
  // is then read once more, so the body disappears at once instead of after the next library cleanup.
  return await markDeletedSources(database, actorId, data.executions) ? readView(database, actorId, sessionId) : data;
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
async function markDeletedSources(database: SupabaseClient, actorId: string, executions: ViewedExecution[]) {
  // Paused and cost-pending rounds only: their read is side-effect free apart from this mark, unlike a running round.
  const shown = executions.filter(e => ['waiting_credits', 'waiting_resume', 'cost_pending'].includes(String(e.state))
    && !e.unavailableReason
    && (e.body != null || e.primaryBody != null || e.summary != null) && typeof e.executionId === 'string');
  let marked = false;
  for (const execution of shown) {
    const read = await database.rpc('runtime_execution', { p_actor_id: actorId, p_execution_id: execution.executionId,
      p_action: 'read' });
    throwIfContentErased(read.error);
    // Fail closed: a round whose source state cannot be confirmed shows no saved body.
    if (read.error) { delete execution.body; delete execution.primaryBody; delete execution.summary; continue; }
    if ((read.data as { unavailableReason?: unknown } | null)?.unavailableReason === 'source_deleted') marked = true;
  }
  return marked;
}
