/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { nativeMetadata } from './nativeOutput';

const READ_BATCH_SIZE = 8;
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
  // service_role has no table SELECT grant. Reuse the existing scoped read RPC.
  // It returns private context/billing too: keep only the explicit result metadata whitelist.
  // One read per visible execution, bounded to eight outstanding calls per batch.
  const uniqueIds = [...new Set(ids)];
  const metadata = new Map<string, ReturnType<typeof nativeMetadata>>();
  for (let offset = 0; offset < uniqueIds.length; offset += READ_BATCH_SIZE) {
    const batch = uniqueIds.slice(offset, offset + READ_BATCH_SIZE);
    const reads = await Promise.all(batch.map(async executionId => {
      const saved = await database.rpc('runtime_execution', {
        p_actor_id: actorId, p_execution_id: executionId, p_action: 'read',
      });
      const execution = object(saved.data);
      const result = object(execution?.result);
      if (saved.error || execution?.executionId !== executionId || execution.sessionId !== sessionId || !result) {
        throw new Error('RUNTIME_VIEW_DENIED');
      }
      return [executionId, nativeMetadata(result)] as const;
    }));
    for (const [executionId, value] of reads) metadata.set(executionId, value);
  }
  return { ...view.data, executions: executions.map(value => {
    const execution = object(value);
    if (!execution || execution.contentAvailable !== true || typeof execution.body !== 'string'
      || execution.body.length === 0 || typeof execution.executionId !== 'string') return value;
    return { ...execution, ...metadata.get(execution.executionId) };
  }) };
}
