/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';

/** Only a request conflict needs the saved B2 task. Normal new admissions incur no extra read.
 * Use existing permission-checked RPCs: Runtime tables intentionally grant no direct SELECT.
 * The caller re-runs exact SQL request comparison; nothing except the server-owned task changes.
 */
export async function captureReplayTask(admin: SupabaseClient, actorId: string, sessionId: string,
  requestId: string): Promise<string | undefined> {
  const view = await admin.rpc('runtime_view', {p_actor_id: actorId, p_session_id: sessionId});
  if (view.error) throw new Error('OPC_REQUEST_CONFLICT');
  const entry = view.data?.executions?.find((e: {request?: {requestId?: string}}) => e.request?.requestId === requestId);
  if (!entry) return undefined;
  const result = await admin.rpc('runtime_execution', {
    p_actor_id: actorId, p_execution_id: entry.executionId, p_action: 'read',
  });
  if (result.error || result.data?.sessionId !== sessionId) throw new Error('OPC_REQUEST_CONFLICT');
  const context = result.data?.context;
  if (context?.inputSelection !== 'scope-projection-v2') return undefined;
  const task = context.request?.selection?.task;
  return typeof task === 'string' ? task : undefined;
}

export async function captureAdmissionReplay(admin: SupabaseClient, actorId: string,
  request: {sessionId: string; requestId: string; selection: {task?: string}}, mentor: boolean) {
  const read = () => admin.rpc('runtime_admission_replay', {
    p_actor_id: actorId, p_request_id: request.requestId, p_request: request,
  });
  let replay = await read();
  if (replay.error?.message === 'RUNTIME_REQUEST_CONFLICT' && mentor) {
    const task = await captureReplayTask(admin, actorId, request.sessionId, request.requestId);
    if (task) { request.selection.task = task; replay = await read(); }
  }
  if (replay.error) throw new Error('OPC_REQUEST_CONFLICT');
  return replay.data;
}
