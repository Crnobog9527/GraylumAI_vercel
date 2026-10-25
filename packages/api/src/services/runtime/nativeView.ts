/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import {throwIfContentErased} from '../accountErasure/content';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workItemsFrom } from './workItems';
import { readViewTokens, type ViewTokens } from '../runtimeViewVersion';

/** SQL owns scope, history availability and the public result metadata whitelist. */
export async function readNativeRuntimeView(database: SupabaseClient, actorId: string, sessionId: string) {
  const view = await database.rpc('runtime_view', { p_actor_id: actorId, p_session_id: sessionId });
  return hideSourceBound(database, actorId, checkedView(view, sessionId));
}
/**
 * DB-PERF PR-5a: the conversation refresh reads the view and the coach's work rows in one call
 * (runtime_view_with_work_items). The view keeps every refusal above; the rows stay decorative (none on any problem).
 */
export async function readNativeRuntimeViewWithWorkItems(database: SupabaseClient, actorId: string, sessionId: string) {
  const cached = await readCachedView(database, actorId, sessionId);
  if (cached.hit) return cached.hit;
  const both = await database.rpc('runtime_view_with_work_items', { p_actor_id: actorId, p_session_id: sessionId });
  const data = both.data as { view?: unknown; workItems?: unknown } | null;
  const view = await hideSourceBound(database, actorId, checkedView({ error: both.error, data: data?.view }, sessionId));
  const result = { view, workItems: workItemsFrom(data?.workItems) };
  // Only an idle session is cached, and only under the tokens read BEFORE the database read above.
  if (cached.tokens && !(view as { activeExecution?: unknown }).activeExecution) rememberView(actorId, sessionId, cached.tokens, result);
  return result;
}

/**
 * DB-100 C5: a refresh of an idle conversation that nothing has written to since the last read is answered from this
 * instance's memory. Never skipped: "may this user see this session" (runtime_view_access, a small read that raises
 * the same RUNTIME_SCOPE_DENIED as runtime_view). Skipped only: reading and decoding every turn's content.
 * A hit needs all of: the same user and session, an unchanged user token and shared token in Redis (any server-side write
 * naming the user, or naming nobody, replaces them: runtimeViewVersion.ts), a session that is idle now, and an entry
 * younger than VIEW_CACHE_MS. Redis unavailable, an unknown value or any doubt reads the database as before.
 * The content stays in this process only; Redis holds random version tokens, never conversation text.
 */
export const VIEW_CACHE_MS = 30_000;
const VIEW_CACHE_MAX = 200;
type Result = { view: Awaited<ReturnType<typeof readNativeRuntimeView>>; workItems: Record<string, unknown[]> };
const viewCache = new Map<string, { at: number; tokens: ViewTokens; result: Result }>();
export function clearViewCache() { viewCache.clear(); }

function rememberView(actorId: string, sessionId: string, tokens: ViewTokens, result: Result) {
  const key = actorId + ':' + sessionId;
  viewCache.delete(key);
  viewCache.set(key, { at: Date.now(), tokens, result: structuredClone(result) });
  while (viewCache.size > VIEW_CACHE_MAX) viewCache.delete(viewCache.keys().next().value as string);
}

async function readCachedView(database: SupabaseClient, actorId: string, sessionId: string):
  Promise<{ hit?: Result; tokens: ViewTokens | null }> {
  const tokens = await readViewTokens(actorId);
  if (!tokens) return { tokens: null };
  const entry = viewCache.get(actorId + ':' + sessionId);
  if (!entry || Date.now() - entry.at > VIEW_CACHE_MS || entry.tokens.actor !== tokens.actor || entry.tokens.global !== tokens.global) {
    return { tokens };
  }
  const access = await database.rpc('runtime_view_access', { p_actor_id: actorId, p_session_id: sessionId });
  // Any refusal is handled by the full read, which raises exactly what it always raised.
  const active = (access.data as { activeExecution?: unknown } | null)?.activeExecution;
  if (access.error || !access.data || active) return { tokens };
  return { hit: structuredClone(entry.result), tokens };
}
async function hideSourceBound<T extends { executions: unknown[] }>(database: SupabaseClient, actorId: string, data: T): Promise<T> {
  const hidden = await sourceBoundBodies(database, actorId, data.executions as ViewedExecution[]);
  for (const execution of data.executions as ViewedExecution[]) {
    if (hidden.has(execution.executionId)) { delete execution.body; delete execution.primaryBody; delete execution.summary; }
  }
  return data;
}
type ViewResponse = Pick<Awaited<ReturnType<SupabaseClient['rpc']>>, 'data' | 'error'>;
function checkedView(view: ViewResponse, sessionId: string) {
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
