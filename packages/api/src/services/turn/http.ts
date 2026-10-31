/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { compareSkillInput, loadCompareTurnParts } from '../fusion/compareLoad';
import { ENDED_STATES } from '../fusion/reviewRecord';
import { runChatTurn, type ChatDeps } from './chat';
import { runCompareTurn } from './compare';
import { codeOf, juryTurn } from './jury';
import { reportTurnRequest, runReportTurn } from './report';
import { runMentorTurn } from './mentor';
import { runResumedTurn } from './resumeTurn';
import { mentorAnswer } from './mentorInput';
import { eventStream, type StreamEvent } from './sse';
import { swallow } from '../../lib/swallow';

/*
 * CORE-PATH-V2 2.2: POST /api/turn, one turn per request, answered as one event stream. Before anything opens: the request
 * shape, the deployment's declared database host against the host it actually connects to (2.8: the only environment check
 * left, refusing a deployment that points at the wrong database), the signed-in account and the request rate limit.
 */
const common = { sessionId: z.string().uuid(), requestId: z.string().uuid() };
export const turnRequest = z.discriminatedUnion('kind', [
  // V2-10: what the composer chose for this message: a Skill the model loads first, library documents it reads first.
  z.object({ kind: z.literal('chat'), ...common, text: z.string().trim().min(1).max(200_000), moduleId: z.string().uuid().optional(),
    references: z.array(z.object({ kind: z.literal('library_document'), documentId: z.string().uuid(),
      version: z.number().int().positive() }).strict()).min(1).max(8).optional() }).strict(),
  // V2-5: the positioning mentor. moduleId is the draft's module (the turn is quoted for its model; turn_open refuses any other);
  // text is the user's words, or the host's opening marker. 8000 characters, as the old mentor request.
  z.object({ kind: z.literal('mentor'), ...common, moduleId: z.string().uuid(), stepId: z.string().min(1).max(128),
    text: z.string().trim().min(1).max(8000), organizeAfter: z.boolean(), answer: mentorAnswer.optional(),
    researchRefreshId: z.string().uuid().optional() }).strict(),
  // V2-10: continue a turn paused for credits. What the user asked was saved at the pause, so any device can send this.
  z.object({ kind: z.literal('resume'), ...common, resumeOf: z.number().int().positive() }).strict(),
  reportTurnRequest,
  // V2-7b: as the old compare request. Everything else is read and checked on the server (compare.ts).
  z.object({ kind: z.literal('compare'), ...common, question: z.string().trim().min(1).max(20_000),
    modelIds: z.array(z.string().uuid()).min(1).max(8), skill: compareSkillInput.optional() }).strict(),
  // V2-7b: as the old review start. The conversation is the review's draft conversation, so the request names none. Adopting a
  // revised report is not a turn (Owner 10-20: no charge, no model call): it stays on R14.
  z.object({ kind: z.literal('jury'), requestId: common.requestId, draftId: z.string().uuid(), sourceVersionId: z.string().uuid(),
    acceptedCredits: z.number().int().positive().optional() }).strict(),
]);

export type TurnHttpDeps = {
  authenticate: (request: Request) => Promise<string | null>;
  rateLimited: (actorId: string) => Promise<boolean>;
  databaseHost: { declared: string | undefined; actual: string };
  chat: ChatDeps;
  /** The signed-in user's own client: a compare's Skill goes through the user-scoped checks of an ordinary turn. */
  userClient: (request: Request) => SupabaseClient;
  /** After the response, the server advances a started review (fusion/background.ts). */
  handReview: (reviewId: string) => void;
};

const json = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Starts the review and its turn; the groups run on the server after the response, so the stream ends here. */
async function runJuryStart(deps: TurnHttpDeps, actorId: string, input: Extract<z.infer<typeof turnRequest>, { kind: 'jury' }>,
  emit: (event: StreamEvent) => void) {
  const { admin, clients, slots, transport, pricing, newWork } = deps.chat;
  const { requestId, draftId, sourceVersionId, acceptedCredits } = input;
  let view;
  try {
    view = await juryTurn({ admin, clients, slots, transport, pricing, calls: newWork.calls, message: newWork.message }, actorId)
      .start({ requestId, draftId, sourceVersionId, ...(acceptedCredits === undefined ? {} : { acceptedCredits }) });
  } catch (error) { return emit({ type: 'error', code: codeOf(error) }); }
  // A request id already used on the old review path has no turn: it is not this request.
  if (!view.turnId) return emit({ type: 'error', code: 'TURN_REQUEST_CONFLICT' });
  if (!ENDED_STATES.has(view.state)) deps.handReview(view.reviewId);
  const frozen = z.object({ fixedPrice: z.object({ credits: z.number(), holdCredits: z.number() }) }).safeParse(view.config);
  emit({ type: 'review', turnId: view.turnId, reviewId: view.reviewId, state: view.state,
    reservedCredits: frozen.success ? frozen.data.fixedPrice.credits + frozen.data.fixedPrice.holdCredits : 0 });
}

export async function handleTurnRequest(request: Request, deps: TurnHttpDeps): Promise<Response> {
  let input;
  try { input = turnRequest.parse(await request.json()); } catch { return json(400, 'TURN_REQUEST_INVALID'); }
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual) return json(503, 'TURN_DATABASE_MISMATCH');
  const actorId = await swallow('turn_authenticate_failed', deps.authenticate(request), null, { category: 'auth' });
  if (!actorId) return json(401, 'TURN_UNAUTHENTICATED');
  // A limiter that cannot answer refuses (fails closed).
  if (await swallow('turn_rate_limit_unavailable', deps.rateLimited(actorId), true, { category: 'api' })) return json(429, 'TURN_RATE_LIMITED');
  if (input.kind === 'resume') return eventStream(emit => runResumedTurn(deps.chat, { actorId, sessionId: input.sessionId,
    requestId: input.requestId, resumeOf: input.resumeOf }, emit));
  if (input.kind === 'report') {
    // A report hears when its page drops the stream (the user's stop, V2-7a); a chat runs to its end regardless.
    const gone = new AbortController();
    const report = { actorId, sessionId: input.sessionId, requestId: input.requestId, moduleId: input.moduleId,
      projectId: input.projectId, roundId: input.roundId, acceptedCredits: input.acceptedCredits };
    return eventStream(emit => runReportTurn(deps.chat, report, emit, gone.signal), () => gone.abort());
  }
  if (input.kind === 'compare') {
    const { sessionId, question, skill } = input;
    return eventStream(emit => runCompareTurn(deps.chat, { actorId, sessionId, requestId: input.requestId, modelIds: input.modelIds,
      parts: () => loadCompareTurnParts({ admin: deps.chat.admin, user: deps.userClient(request), actorId }, { sessionId, question, skill }) }, emit));
  }
  if (input.kind === 'jury') return eventStream(emit => runJuryStart(deps, actorId, input, emit));
  if (input.kind === 'mentor') return eventStream(emit => runMentorTurn(deps.chat, { actorId, sessionId: input.sessionId,
    requestId: input.requestId, moduleId: input.moduleId, stepId: input.stepId, text: input.text, organizeAfter: input.organizeAfter,
    ...(input.answer ? { answer: input.answer } : {}), ...(input.researchRefreshId ? { researchRefreshId: input.researchRefreshId } : {}) }, emit));
  const chosen = { ...(input.moduleId ? { moduleId: input.moduleId } : {}), ...(input.references ? { references: input.references } : {}) };
  return eventStream(emit => runChatTurn(deps.chat, { actorId, sessionId: input.sessionId, requestId: input.requestId, text: input.text,
    ...(Object.keys(chosen).length ? { chosen } : {}) }, emit));
}
