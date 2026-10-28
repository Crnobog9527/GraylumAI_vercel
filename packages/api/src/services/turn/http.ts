/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { runChatTurn, type ChatDeps } from './chat';
import { eventStream } from './sse';
import { swallow } from '../../lib/swallow';

/*
 * CORE-PATH-V2 2.2: POST /api/turn, one turn per request, answered as one event stream. Before anything opens: the request
 * shape, the deployment's declared database host against the host it actually connects to (2.8: the only environment check
 * left, refusing a deployment that points at the wrong database), the signed-in account and the request rate limit.
 */
export const turnRequest = z.object({
  kind: z.literal('chat'), sessionId: z.string().uuid(), requestId: z.string().uuid(),
  text: z.string().trim().min(1).max(200_000),
}).strict();

export type TurnHttpDeps = {
  authenticate: (request: Request) => Promise<string | null>;
  rateLimited: (actorId: string) => Promise<boolean>;
  databaseHost: { declared: string | undefined; actual: string };
  chat: ChatDeps;
};

const json = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleTurnRequest(request: Request, deps: TurnHttpDeps): Promise<Response> {
  let input;
  try { input = turnRequest.parse(await request.json()); } catch { return json(400, 'TURN_REQUEST_INVALID'); }
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual) return json(503, 'TURN_DATABASE_MISMATCH');
  const actorId = await swallow('turn_authenticate_failed', deps.authenticate(request), null, { category: 'auth' });
  if (!actorId) return json(401, 'TURN_UNAUTHENTICATED');
  // A limiter that cannot answer refuses (fails closed).
  if (await swallow('turn_rate_limit_unavailable', deps.rateLimited(actorId), true, { category: 'api' })) return json(429, 'TURN_RATE_LIMITED');
  return eventStream(emit => runChatTurn(deps.chat, { actorId, sessionId: input.sessionId, requestId: input.requestId, text: input.text }, emit));
}
