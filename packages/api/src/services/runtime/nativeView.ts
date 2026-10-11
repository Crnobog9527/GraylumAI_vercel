/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import {throwIfContentErased} from '../accountErasure/content';
import type { SupabaseClient } from '@supabase/supabase-js';
/** SQL owns scope, history availability and the public result metadata whitelist. */
export async function readNativeRuntimeView(database: SupabaseClient, actorId: string, sessionId: string) {
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
