/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import { runTurn } from "@/lib/turn-stream";

/*
 * CORE-PATH-V2 V2-10b: the first-week plan on POST /api/turn (kind=plan). A request is known by its id: GET /api/turn/plan reads it
 * after the stream, a dropped connection or a reload, so a request is sent once and its plan is never paid for twice. A plan that
 * cannot be read as one (the model's body, or a turn that failed) answers `valid: false`, as opc.planResult: the page releases
 * the request and the next click is a new one.
 */
const READ_MS = 3000, READS = 120;
export type PlanTurn = { turnId: number; state: string; closeKind: string | null; chargedCredits: number | null; settlement: string | null;
  valid: boolean; items: unknown[] | null; sourceRoundId: string | null; sourceVersionId: string | null };
export type PlanTurnDeps = { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> };
export type PlanTurnRequest = { requestId: string; stepId: string; input: string };
const browser: PlanTurnDeps = { fetch: (...args) => globalThis.fetch(...args) };

/** The request's plan turn, or null when this request has none. */
export async function readPlanTurn(sessionId: string, requestId: string, deps: PlanTurnDeps = browser): Promise<PlanTurn | null> {
  const query = `sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}`;
  const response = await deps.fetch(`/api/turn/plan?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error("TURN_PLAN_READ_FAILED");
  return (await response.json() as { plan: PlanTurn | null }).plan;
}

/** The retained request's turn, for the page's recovery; null while there is none or it cannot be read (the old record answers then). */
export function usePlanTurn(sessionId: string | undefined, requestId: string | undefined) {
  const [turn, setTurn] = useState<PlanTurn | null>(null);
  useEffect(() => {
    setTurn(null);
    if (sessionId && requestId) void readPlanTurn(sessionId, requestId).then(setTurn, () => undefined);
  }, [sessionId, requestId]);
  return turn;
}

/** What the page's recovery shows for a retained request that has a turn (the shape of opc.planRequestState's answer). */
export function planTurnState(turn: PlanTurn) {
  return { admitted: true, materialRevoked: false, hasResult: turn.valid, state: turn.state === "closed" ? "completed" : "running" };
}

async function closed(sessionId: string, requestId: string, deps: PlanTurnDeps): Promise<PlanTurn | null> {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let read = 0; read < READS; read++) {
    const turn = await readPlanTurn(sessionId, requestId, deps).catch(() => null);
    if (turn?.state === "closed") return turn;
    await sleep(READ_MS);
  }
  return null;
}

/** Sends the request unless it already has a turn, and answers as opc.planResult does. A refusal before opening is thrown with its code. */
export async function runPlanTurn(request: PlanTurnRequest, ids: { sessionId: string; moduleId: string }, known: PlanTurn | null,
  deps: PlanTurnDeps = browser) {
  if (!known) {
    const outcome = await runTurn({ kind: "plan", ...ids, requestId: request.requestId, stepId: request.stepId, text: request.input },
      () => undefined, { fetch: deps.fetch });
    if (outcome.state === "refused") throw new Error(outcome.code);
    // Refused before opening (no turn): nothing to read. With a turn, its close decides, on this page or after a reload.
    if (outcome.state === "finished" && outcome.last.type === "error" && outcome.last.turnId === undefined) throw new Error(outcome.last.code);
  }
  const turn = await closed(ids.sessionId, request.requestId, deps);
  if (!turn) throw new Error("TURN_PLAN_READ_FAILED");
  return turn.valid ? { valid: true as const, body: turn.items as never, sourceRoundId: turn.sourceRoundId as string } : { valid: false as const };
}
