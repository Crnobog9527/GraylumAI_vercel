/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { opcTopicTurn } from '../../shared/opcRequests';
import { swallow } from '../../lib/swallow';
import type { ChatDeps } from './chat';
import { eventStream } from './sse';
import { runTopicTurn } from './topic';

/* CORE-PATH-V2 V2-10b POST /api/turn/topic: one topic turn, one stream, with the checks of POST /api/turn before anything opens. */
export type TopicHttpDeps = {
  authenticate: (request: Request) => Promise<string | null>;
  rateLimited: (actorId: string) => Promise<boolean>;
  databaseHost: { declared: string | undefined; actual: string };
  chat: ChatDeps;
};
const json = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleTopicTurn(request: Request, deps: TopicHttpDeps): Promise<Response> {
  let input;
  try { input = opcTopicTurn.parse(await request.json()); } catch { return json(400, 'TURN_REQUEST_INVALID'); }
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual) return json(503, 'TURN_DATABASE_MISMATCH');
  const actorId = await swallow('turn_authenticate_failed', deps.authenticate(request), null, { category: 'auth' });
  if (!actorId) return json(401, 'TURN_UNAUTHENTICATED');
  // A limiter that cannot answer refuses (fails closed).
  if (await swallow('turn_rate_limit_unavailable', deps.rateLimited(actorId), true, { category: 'api' })) return json(429, 'TURN_RATE_LIMITED');
  return eventStream(emit => runTopicTurn(deps.chat, { actorId, draftId: input.draftId, requestId: input.requestId, text: input.input }, emit));
}
