/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { planItem } from '../../shared/opcRequests';
import { swallow } from '../../lib/swallow';
import type { ReportHttpDeps } from './reportHttp';

/*
 * CORE-PATH-V2 V2-10b GET /api/turn/plan: a request's plan turn and its plan, for the page after the stream or a reload (a repeated
 * request never runs the model again). `valid` says the saved text is a usable plan; a closed turn with valid:false paid by usage
 * and the page starts a new request, as on the old path.
 */
export const planReadRequest = z.object({ sessionId: z.string().uuid(), requestId: z.string().uuid() }).strict();
const read = z.object({ turnId: z.number(), state: z.string(), closeKind: z.string().nullable(), delivered: z.boolean(),
  chargedCredits: z.number().nullable(), settlement: z.string().nullable(), body: z.string().nullable(),
  sourceRoundId: z.string().nullable(), sourceVersionId: z.string().nullable() }).strict();
const planBody = z.array(planItem).min(1).max(28);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** The saved text as a plan; a body that is no plan is null. */
export function parsePlan(body: string | null) {
  if (body === null) return null;
  try { return planBody.parse(JSON.parse(body)); } catch { return null; }
}

export async function handlePlanRead(request: Request, deps: ReportHttpDeps): Promise<Response> {
  let input;
  try { input = planReadRequest.parse(Object.fromEntries(new URL(request.url).searchParams)); }
  catch { return json(400, { error: 'TURN_REQUEST_INVALID' }); }
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual)
    return json(503, { error: 'TURN_DATABASE_MISMATCH' });
  const actorId = await swallow('turn_plan_auth_failed', deps.authenticate(request), null, { category: 'api' });
  if (!actorId) return json(401, { error: 'TURN_UNAUTHENTICATED' });
  const { data, error } = await deps.clients.read.rpc('turn_plan_read', { p_actor_id: actorId, p_session_id: input.sessionId,
    p_request_id: input.requestId });
  if (error) return /TURN_SESSION_DENIED/.test(error.message ?? '') ? json(404, { error: 'TURN_SESSION_DENIED' })
    : json(503, { error: 'TURN_DATABASE_UNAVAILABLE' });
  if (data === null) return json(200, { plan: null });
  const turn = read.parse(data), items = parsePlan(turn.body);
  return json(200, { plan: { turnId: turn.turnId, state: turn.state, closeKind: turn.closeKind, chargedCredits: turn.chargedCredits,
    settlement: turn.settlement, valid: items !== null, items, sourceRoundId: turn.sourceRoundId, sourceVersionId: turn.sourceVersionId } });
}
