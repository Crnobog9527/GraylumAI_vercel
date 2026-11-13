/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

/*
 * CONTENT-CONVERSATION-2 (Owner 2026-11-14): the minutes of one conversation ("整理纪要" / "整理本选题"), newest first. One read
 * (turn_session_minutes, migration 0533) by the owner's key after the conversation's scope check (session_view_allowed, as the
 * turn view). The minutes themselves are made by a turn (POST /api/turn kind=minutes); nothing is written here.
 */
const uuid = z.string().uuid();
export const sessionMinutesList = z.object({ sessionId: uuid }).strict();
export const sessionMinutes = z.object({
  turnId: z.number().int().positive(), requestId: uuid, state: z.enum(['opening', 'running', 'stopping', 'paused', 'closed']),
  closeKind: z.string().nullable(), failureCode: z.string().nullable(), chargedCredits: z.number().int().nullable(),
  openedAt: z.string(), closedAt: z.string().nullable(),
  /** Null when the minutes were deleted with their conversation's content, or when the turn delivered none. */
  body: z.string().nullable(), available: z.boolean(),
});
export type SessionMinutes = z.infer<typeof sessionMinutes>;

type Database = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> };
const KNOWN = /\b(TURN_ACCOUNT_DENIED|TURN_SESSION_DENIED|TURN_SESSION_ERASED)\b/;
const refusal = (message: string | undefined) => {
  const code = KNOWN.exec(message ?? '')?.[1];
  return new TRPCError(code ? { code: 'FORBIDDEN', message: code } : { code: 'INTERNAL_SERVER_ERROR', message: 'MINUTES_UNAVAILABLE' });
};

export async function listSessionMinutes(database: Database, actorId: string, input: z.infer<typeof sessionMinutesList>): Promise<SessionMinutes[]> {
  const allowed = await database.rpc('session_view_allowed', { p_actor_id: actorId, p_session_id: input.sessionId });
  if (allowed.error) throw refusal(allowed.error.message);
  if (allowed.data === false) throw refusal('TURN_SESSION_DENIED');
  const { data, error } = await database.rpc('turn_session_minutes', { p_actor_id: actorId, p_session_id: input.sessionId });
  if (error) throw refusal(error.message);
  const parsed = z.array(sessionMinutes).safeParse(data);
  if (!parsed.success) throw refusal(undefined);
  return parsed.data;
}
