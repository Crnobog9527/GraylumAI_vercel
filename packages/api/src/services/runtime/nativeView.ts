/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { nativeMetadata } from './nativeOutput';

const columns = 'id,completeness:result->completeness,organized:result->organized,' +
  'summaryOmitted:result->summaryOmitted,messageFirst:result->messageFirst,envelopeCompact:result->envelopeCompact';
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** SQL remains the authority for scope and history availability; enrich only its visible replies. */
export async function readNativeRuntimeView(database: SupabaseClient, actorId: string, sessionId: string) {
  const view = await database.rpc('runtime_view', { p_actor_id: actorId, p_session_id: sessionId });
  if (view.error || !view.data || view.data.sessionId !== sessionId || !Array.isArray(view.data.executions)) {
    throw new Error('RUNTIME_VIEW_DENIED');
  }
  const executions: unknown[] = view.data.executions;
  const ids = executions.flatMap(value => {
    const execution = object(value);
    return execution?.contentAvailable === true && typeof execution.body === 'string' && execution.body.length > 0
      && typeof execution.executionId === 'string' ? [execution.executionId] : [];
  });
  if (!ids.length) return view.data;
  // Never fetch result body, summary, payload or any other private execution columns.
  const saved = await database.from('runtime_executions').select(columns)
    .eq('actor_id', actorId).eq('session_id', sessionId).in('id', ids);
  if (saved.error || !Array.isArray(saved.data)) throw new Error('RUNTIME_VIEW_DENIED');
  const permitted = new Set(ids);
  const metadata = new Map(saved.data.flatMap(row => {
    const value = object(row);
    return value && typeof value.id === 'string' && permitted.has(value.id)
      ? [[value.id, nativeMetadata(value)] as const] : [];
  }));
  return { ...view.data, executions: executions.map(value => {
    const execution = object(value);
    if (!execution || execution.contentAvailable !== true || typeof execution.body !== 'string'
      || execution.body.length === 0 || typeof execution.executionId !== 'string') return value;
    return { ...execution, ...metadata.get(execution.executionId) };
  }) };
}
