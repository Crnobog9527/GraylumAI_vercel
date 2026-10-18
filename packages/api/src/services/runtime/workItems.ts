/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';

/**
 * CHAT-AUTO-CONTEXT A2b: what the coach read before each answer (runtime_work_items), for the rows above a reply.
 * Decorative: any failure (older database without the function, a timeout) returns nothing and never breaks the view.
 */
export async function readWorkItems(database: SupabaseClient, actorId: string, sessionId: string): Promise<Record<string, unknown[]>> {
  try {
    const result = await database.rpc('runtime_work_items', {p_actor_id: actorId, p_session_id: sessionId});
    if (result.error || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return {};
    const items: Record<string, unknown[]> = {};
    for (const [executionId, rows] of Object.entries(result.data as Record<string, unknown>)) {
      if (Array.isArray(rows) && rows.length) items[executionId] = rows;
    }
    return items;
  } catch {
    return {};
  }
}

/** The view with each answer's work rows attached under `workItems` (answers without rows are left untouched). */
export function withWorkItems<T extends {executions: unknown[]}>(view: T, items: Record<string, unknown[]>): T {
  if (!Object.keys(items).length) return view;
  const executions = view.executions.map(execution => {
    const id = (execution as {executionId?: unknown} | null)?.executionId;
    const rows = typeof id === 'string' ? items[id] : undefined;
    return rows ? {...(execution as object), workItems: rows} : execution;
  });
  return {...view, executions};
}
