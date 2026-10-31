/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import { isOpeningInput } from "@repo/api/src/shared/opcQuestions";
import type { TurnEvent } from "@repo/api/src/services/turn/sse";
import type { TurnView } from "@repo/api/src/services/turn/view";
import { runTurn } from "@/lib/turn-stream";
import { turnCodeNotice } from "@/app/(zh-hans)/app/runtime/turn-notices";
import { STREAM_INTERRUPTED, type MentorExecution, type MentorRequest, type MentorTurn } from "./mentor-turn";

/*
 * CORE-PATH-V2 V2-10: the positioning page on POST /api/turn. The page and its recovery work on executions and on the draft's turn
 * bindings, so this file gives it those from the turn path: each saved exchange (session_messages) is one finished execution,
 * its step read from the saved reply; the running turn is the active one. Ids are `turn:<id>`, never a uuid, so a turn is never
 * confused with an execution of the old path (a plan still runs there).
 */
export const turnExecutionId = (turnId: number) => `turn:${turnId}`;
export const isTurnExecution = (id: string) => id.startsWith("turn:");
export type TurnHistory = { executions: (MentorExecution & { replySeq?: number })[]; activeExecution: string | null };

/** The step and round a saved reply names; a reply saved before rounds were written has no round. */
const placeOf = (body: string) => {
  try {
    const { stepId, roundId } = JSON.parse(body) as { stepId?: unknown; roundId?: unknown };
    return { stepId: typeof stepId === "string" ? stepId : null, ...(typeof roundId === "string" ? { roundId } : {}) };
  } catch { return { stepId: null }; }
};

/**
 * One opening per step and round. Any turn of this step in this round means the step is already open; a turn of an older round
 * never suppresses the current round's opening. A turn without a round keeps the round-blind behaviour.
 */
export function stepOpened(turns: readonly { stepId: string; roundId?: string | null; kind: string }[], stepId: string, roundId: string | null) {
  return turns.some(turn => turn.stepId === stepId && (!Object.hasOwn(turn, "roundId") || turn.roundId === roundId)
    && ["mentor", "organizer", "opening"].includes(turn.kind));
}

export function turnHistory(view: TurnView): TurnHistory & { turns: MentorTurn[] } {
  const executions: TurnHistory["executions"] = [], turns: MentorTurn[] = [];
  for (const reply of view.messages) {
    if (reply.role !== "assistant" || reply.turnId === null) continue;
    const executionId = turnExecutionId(reply.turnId), { stepId, ...round } = placeOf(reply.content);
    const input = view.messages.find(message => message.role === "user" && message.turnId === reply.turnId)?.content ?? null;
    executions.push({ executionId, input, body: reply.content, primaryBody: reply.content, summary: null, state: "completed", replySeq: reply.seq });
    if (stepId) turns.push({ executionId, stepId, ...round, questionId: null, kind: isOpeningInput(input ?? "") ? "opening" : "mentor" });
  }
  const active = view.activeTurn ? turnExecutionId(view.activeTurn.turnId) : null;
  if (active) executions.push({ executionId: active, input: null, body: null, primaryBody: null, summary: null,
    state: view.activeTurn?.pauseReason === "waiting_credits" ? "waiting_credits" : "running" });
  return { executions, turns, activeExecution: active };
}

/** The one mentor request the turn path takes for what the page sends; an answered card is named by the message it answered. */
export function mentorTurnBody(request: MentorRequest, ids: { sessionId: string; moduleId: string }, history: TurnHistory) {
  const sourceSeq = request.answerSource ? history.executions.find(e => e.executionId === request.answerSource!.executionId)?.replySeq : undefined;
  return { kind: "mentor", ...ids, requestId: request.requestId, stepId: request.stepId, text: request.input,
    organizeAfter: request.organizeAfter ?? false,
    ...(sourceSeq === undefined ? {} : { answer: { sourceSeq,
      ...(request.answerSource!.optionIndex === undefined ? {} : { optionIndex: request.answerSource!.optionIndex }) } }),
    ...(request.researchRefreshId ? { researchRefreshId: request.researchRefreshId } : {}) };
}

/** A turn the server refused or ended, with its fixed notice; `kept` proves nothing was stored. */
export class TurnRefused extends Error {
  constructor(readonly code: string, text: string, readonly kept: boolean) { super(text); }
}

const refused = (code: string) => { const { text, kept } = turnCodeNotice(code); return new TurnRefused(code, text, kept); };

/** One turn's events as the page's stream reader takes them. A dropped stream throws STREAM_INTERRUPTED: the page reads back. */
export async function* mentorTurnEvents(body: unknown, opener: typeof runTurn = runTurn): AsyncGenerator<AgentTurnEvent> {
  const queue: AgentTurnEvent[] = [];
  let wake = () => {}, finished = false, failure: Error | null = null, offset = 0, turnId = 0;
  const push = (event: AgentTurnEvent) => { queue.push(event); wake(); };
  const onEvent = (event: TurnEvent) => {
    if (event.type === "opened") { turnId = event.turnId; push({ type: "admitted", executionId: turnExecutionId(event.turnId) }); }
    else if (event.type === "text") { push({ type: "textDelta", text: event.delta, offset, rev: 1 }); offset += Array.from(event.delta).length; }
    else if (event.type === "result") push({ type: "result", result: { state: "completed", executionId: turnExecutionId(event.turnId) } as AgentTurnOutcome });
    else if (event.type === "research_card" || event.type === "research_continue" || event.type === "research_call") push(event);
  };
  void opener(body, onEvent).then(outcome => {
    if (outcome.state === "lost") failure = new Error(STREAM_INTERRUPTED);
    else if (outcome.state === "refused") failure = refused(outcome.code);
    else if (outcome.last.type === "error" && outcome.last.code !== "TURN_REQUEST_REPLAYED") failure = refused(outcome.last.code);
    else if (outcome.last.type === "error") push({ type: "result", result: { state: "completed", executionId: turnExecutionId(turnId) } as AgentTurnOutcome });
    finished = true; wake();
  });
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>(resolve => { wake = resolve; });
  }
  if (failure) throw failure;
}

/** Every saved message: one read answers at most 50, oldest first. */
export async function readTurnView(sessionId: string, fetcher: typeof fetch): Promise<TurnView | null> {
  let merged: TurnView | null = null, afterSeq = 0;
  for (;;) {
    let page: TurnView;
    try {
      const response = await fetcher(`/api/turn?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${afterSeq}`, { cache: "no-store" });
      if (!response.ok) return null;
      page = await response.json() as TurnView;
    } catch { return null; }
    merged = merged ? { ...page, messages: [...merged.messages, ...page.messages] } : page;
    if (page.messages.length < 50) return merged;
    afterSeq = page.messages.at(-1)!.seq;
  }
}
