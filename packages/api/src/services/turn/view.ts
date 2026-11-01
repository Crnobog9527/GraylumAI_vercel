/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { TurnClients } from './db';

/*
 * CORE-PATH-V2 V2-5b, refresh recovery (Owner 10-02, #595): GET /api/turn?sessionId=&afterSeq= answers, after a reload, whether
 * this conversation's turn is still running (so the page shows it and waits), its latest closed turn and the messages saved
 * after afterSeq (so the result appears without the user doing anything). One read on the read client (a replica later, 3.3.2
 * item 5); nothing is written and no turn is affected. A failure is a fixed code; the page shows its one-line retry only then.
 */
const viewRequest = z.object({ sessionId: z.string().uuid(), afterSeq: z.coerce.number().int().min(0).max(1_000_000).default(0) }).strict();
const turnView = z.object({
  activeTurn: z.object({ turnId: z.number().int().positive(), kind: z.string(), state: z.enum(['opening', 'running', 'stopping', 'paused']),
    pauseReason: z.string().nullable(), openedAt: z.string(), updatedAt: z.string() }).nullable(),
  lastTurn: z.object({ turnId: z.number().int().positive(), kind: z.string(), closeKind: z.string(), failureCode: z.string().nullable(),
    settlement: z.enum(['pending', 'done']).nullable(), chargedCredits: z.number().int().nullable(), closedAt: z.string() }).nullable(),
  messages: z.array(z.object({ seq: z.number().int().positive(), role: z.enum(['user', 'assistant']), turnId: z.number().int().nullable(),
    content: z.string() })),
  // The paid tool calls behind these replies, for the work rows after a reload. Absent until migration 0441.
  calls: z.array(z.object({ turnId: z.number().int(), seq: z.number().int(), toolName: z.string().nullable(), status: z.string(),
    usage: z.unknown(), q: z.unknown(), multiplier: z.unknown(), arguments: z.string().nullable() })).default([]),
});
export type TurnView = z.infer<typeof turnView>;

export type TurnViewDeps = {
  authenticate: (request: Request) => Promise<string | null>;
  databaseHost: { declared: string | undefined; actual: string };
  clients: TurnClients;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const KNOWN = /\b(TURN_ACCOUNT_DENIED|TURN_SESSION_DENIED|TURN_SESSION_ERASED)\b/;

const refused = (error: { message?: string }) => {
  const code = KNOWN.exec(error.message ?? '')?.[1];
  return json(code ? 403 : 503, { error: code ?? 'TURN_VIEW_UNAVAILABLE' });
};

export async function handleTurnView(request: Request, deps: TurnViewDeps): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const input = viewRequest.safeParse(params);
  if (!input.success) return json(400, { error: 'TURN_REQUEST_INVALID' });
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual) return json(503, { error: 'TURN_DATABASE_MISMATCH' });
  let actorId: string | null;
  try { actorId = await deps.authenticate(request); } catch { actorId = null; }
  if (!actorId) return json(401, { error: 'TURN_UNAUTHENTICATED' });
  // The conversation's scope first: the whole old chain, kept off the view itself (V2-5d).
  const allowed = await deps.clients.read.rpc('session_view_allowed', { p_actor_id: actorId, p_session_id: input.data.sessionId });
  if (allowed.error) return refused(allowed.error);
  // A session that is not the actor's answers NULL, and turn_session_view says why; a false is a scope refused.
  if (allowed.data === false) return json(403, { error: 'TURN_SESSION_DENIED' });
  const { data, error } = await deps.clients.read.rpc('turn_session_view', { p_actor_id: actorId, p_session_id: input.data.sessionId,
    p_after_seq: input.data.afterSeq });
  if (error) return refused(error);
  const view = turnView.safeParse(data);
  return view.success ? json(200, view.data) : json(503, { error: 'TURN_VIEW_UNAVAILABLE' });
}
