/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { swallow } from '../../lib/swallow';
import { turnDatabase, TurnDatabaseError, type TurnClients } from './db';
import { redisReportStopSignal, type ReportStopSignal } from './reportStopSignal';

/*
 * CORE-PATH-V2 V2-7a: the report's two requests besides its turn. POST /api/turn/stop records the user's stop (turn_stop):
 * the first two stops within 24 hours are free; from the third the answer is `confirmation_required` until the page sends
 * the same stop with confirmed:true, and the stop then charges what was generated, at most the fixed price. After `stopping`
 * a Redis flag tells the running turn to abort its provider call and close as stopped. GET /api/turn/report
 * reads the newest report of a round (or one turn) with its saved text, for a reload or after a stop.
 */
export const stopRequest = z.object({
  turnId: z.number().int().positive(), confirmed: z.boolean().optional(),
  // What the page showed, in code points (Array.from(text).length); the stopped report keeps exactly that much.
  stopAt: z.number().int().min(0).max(2147483647).optional(),
}).strict();
export const reportReadRequest = z.object({ sessionId: z.string().uuid(), roundId: z.string().uuid().optional(),
  turnId: z.coerce.number().int().positive().optional() }).strict();

export type ReportHttpDeps = {
  authenticate: (request: Request) => Promise<string | null>;
  databaseHost: { declared: string | undefined; actual: string };
  clients: TurnClients;
  stopSignal?: ReportStopSignal;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const STATUS: Record<string, number> = { TURN_DENIED: 404, TURN_SESSION_DENIED: 404, TURN_STOP_NOT_ALLOWED: 403,
  TURN_NOT_RUNNING: 409 };

async function admitted(request: Request, deps: ReportHttpDeps): Promise<string | Response> {
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual)
    return json(503, { error: 'TURN_DATABASE_MISMATCH' });
  const actorId = await swallow('turn_report_auth_failed', deps.authenticate(request), null, { category: 'api' });
  return actorId ?? json(401, { error: 'TURN_UNAUTHENTICATED' });
}
const failed = (error: unknown) => {
  const code = error instanceof TurnDatabaseError ? error.code : 'TURN_DATABASE_UNAVAILABLE';
  return json(STATUS[code] ?? 503, { error: code });
};

export async function handleTurnStop(request: Request, deps: ReportHttpDeps): Promise<Response> {
  let input;
  try { input = stopRequest.parse(await request.json()); } catch { return json(400, { error: 'TURN_REQUEST_INVALID' }); }
  const actorId = await admitted(request, deps);
  if (typeof actorId !== 'string') return actorId;
  try {
    const stopped = await turnDatabase(deps.clients).stop({ actorId, turnId: input.turnId, confirmed: input.confirmed === true,
      stopAt: input.stopAt ?? null });
    // Recorded either way: an unraised flag only lets the report run to its end, and it still closes as stopped.
    if (stopped.state === 'stopping') await swallow('turn_report_stop_raise_failed',
      (deps.stopSignal ?? redisReportStopSignal()).raise(input.turnId), undefined, { category: 'api' });
    return json(200, stopped);
  } catch (error) { return failed(error); }
}

export async function handleReportRead(request: Request, deps: ReportHttpDeps): Promise<Response> {
  let input;
  try { input = reportReadRequest.parse(Object.fromEntries(new URL(request.url).searchParams)); }
  catch { return json(400, { error: 'TURN_REQUEST_INVALID' }); }
  const actorId = await admitted(request, deps);
  if (typeof actorId !== 'string') return actorId;
  try {
    const turn = await turnDatabase(deps.clients).reportRead({ actorId, sessionId: input.sessionId, roundId: input.roundId ?? null,
      turnId: input.turnId ?? null });
    return json(200, { report: turn });
  } catch (error) { return failed(error); }
}
