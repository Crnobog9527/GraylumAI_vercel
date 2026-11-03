/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { throwIfContentErased } from '../accountErasure/content';

const uuid = z.string().uuid();
/** What a conversation page needs to open its workspace (CORE-PATH-V2): the scope, and whether it is an older conversation. */
const sessionScope = z.object({
  sessionId: uuid,
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('positioning_draft') }),
    z.object({ kind: z.literal('work_item'), projectId: uuid, workItemId: uuid }),
  ]),
  /** The conversation came from the removed execution model and has no turns: the page shows it as unsupported. */
  legacy: z.boolean(),
}).strict();

/** SQL owns ownership, scope and erasure; the reply never reveals whether another actor's session exists. */
export async function readRuntimeSessionScope(admin: SupabaseClient, actorId: string, sessionId: string) {
  const result = await admin.rpc('runtime_session_scope', { p_actor_id: actorId, p_session_id: sessionId });
  throwIfContentErased(result.error);
  if (result.error?.message === 'RUNTIME_SCOPE_DENIED') throw new TRPCError({ code: 'NOT_FOUND', message: 'RUNTIME_SESSION_NOT_FOUND' });
  const parsed = sessionScope.safeParse(result.data);
  if (result.error || !parsed.success || parsed.data.sessionId !== sessionId) throw new Error('RUNTIME_VIEW_DENIED');
  return parsed.data;
}
