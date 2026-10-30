/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { runChatTurn, type ChatDeps } from './chat';
import { runMentorTurn } from './mentor';
import { mentorAnswer } from './mentorInput';
import { eventStream } from './sse';
import { swallow } from '../../lib/swallow';

/*
 * CORE-PATH-V2 2.2: POST /api/turn, one turn per request, answered as one event stream. Before anything opens: the request
 * shape, the deployment's declared database host against the host it actually connects to (2.8: the only environment check
 * left, refusing a deployment that points at the wrong database), the signed-in account and the request rate limit.
 */
const common = { sessionId: z.string().uuid(), requestId: z.string().uuid() };
export const turnRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), ...common, text: z.string().trim().min(1).max(200_000) }).strict(),
  // V2-5: the positioning mentor. moduleId is the draft's module (the turn is quoted for its model; turn_open refuses any other);
  // text is the user's words, or the host's opening marker. 8000 characters, as the old mentor request.
  z.object({ kind: z.literal('mentor'), ...common, moduleId: z.string().uuid(), stepId: z.string().min(1).max(128),
    text: z.string().trim().min(1).max(8000), organizeAfter: z.boolean(), answer: mentorAnswer.optional() }).strict(),
]);

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
  if (input.kind === 'mentor') return eventStream(emit => runMentorTurn(deps.chat, { actorId, sessionId: input.sessionId,
    requestId: input.requestId, moduleId: input.moduleId, stepId: input.stepId, text: input.text, organizeAfter: input.organizeAfter,
    ...(input.answer ? { answer: input.answer } : {}) }, emit));
  return eventStream(emit => runChatTurn(deps.chat, { actorId, sessionId: input.sessionId, requestId: input.requestId, text: input.text }, emit));
}
