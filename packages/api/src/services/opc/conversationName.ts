/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { stagingRpcFailure } from '../runtime/stagingErrors';

/** UI-FINISH (Owner 2026-10-13): ordinary conversations can be renamed; an empty name restores the default. */
export const conversationRename = z.object({
  sessionId: z.string().uuid(),
  name: z.string().max(200),
}).strict();

type Database = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{
  data: unknown; error: { code?: string; message?: string } | null;
}> };

// Bounded refusals the sidebar maps to plain text; every other failure stays private.
const REFUSALS: Record<string, string> = {
  CONVERSATION_NOT_FOUND: 'OPC_CONVERSATION_NOT_FOUND',
  CONTENT_ERASED: 'OPC_CONVERSATION_ERASED',
  CONVERSATION_NAME_INVALID: 'OPC_CONVERSATION_NAME_INVALID',
};

/** The actor comes from the verified session; SQL checks ownership, deletion and the name. */
export async function renameConversation(database: Database, actorId: string, input: z.infer<typeof conversationRename>) {
  const { sessionId, name } = conversationRename.parse(input);
  const { data, error } = await database.rpc('opc_conversation_rename', {
    p_actor_id: actorId, p_session_id: sessionId, p_name: name,
  });
  if (error) {
    const refusal = error.message ? REFUSALS[error.message] : undefined;
    if (refusal) throw new Error(refusal);
    stagingRpcFailure(error);
  }
  return z.object({ sessionId: z.string().uuid(), name: z.string().nullable() }).strict().parse(data);
}
