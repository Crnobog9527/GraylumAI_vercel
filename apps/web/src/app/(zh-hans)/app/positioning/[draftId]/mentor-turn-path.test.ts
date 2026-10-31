/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { STREAM_INTERRUPTED } from "./mentor-turn";
import { envelopeWithExecution, parseStepEnvelope } from "./mentor-turn";
import { envelopeExecution } from "./step-recovery";
import { mentorTurnBody, mentorTurnEvents, readTurnView, stepOpened, turnHistory, TurnRefused } from "./mentor-turn-path";

const view = (messages: unknown[], activeTurn: unknown = null) => ({ activeTurn, lastTurn: null, messages, calls: [] }) as never;
const reply = (seq: number, turnId: number, stepId = "s1") => ({ seq, role: "assistant", turnId, content: JSON.stringify({ format: "agent-turn.v1", message: "好", card: null, stepId }) });

describe("mentor on the turn path", () => {
  it("turns saved exchanges into executions and bindings, and the running turn into the active one", () => {
    const history = turnHistory(view([{ seq: 1, role: "user", turnId: 4, content: "我做健身" }, reply(2, 4)],
      { turnId: 5, kind: "mentor", state: "running", pauseReason: null, openedAt: "", updatedAt: "" }));
    expect(history.turns).toEqual([{ executionId: "turn:4", stepId: "s1", questionId: null, kind: "mentor" }]);
    expect(history.executions.map(e => [e.executionId, e.state, e.input])).toEqual([["turn:4", "completed", "我做健身"], ["turn:5", "running", null]]);
    expect(history.activeExecution).toBe("turn:5");
  });
  it("binds a reply to its round; a reply saved without one still reads", () => {
    const withRound = { seq: 2, role: "assistant", turnId: 4, content: JSON.stringify({ message: "好", stepId: "s1", roundId: "r1" }) };
    expect(turnHistory(view([withRound])).turns).toEqual([{ executionId: "turn:4", stepId: "s1", roundId: "r1", questionId: null, kind: "mentor" }]);
    expect(Object.hasOwn(turnHistory(view([reply(2, 4)])).turns[0]!, "roundId")).toBe(false);
  });
  it("a new round opens its step: an older round's turn does not count, this round's and a roundless one do", () => {
    const turn = (roundId?: string) => ({ stepId: "s1", kind: "mentor", ...(roundId ? { roundId } : {}) });
    expect(stepOpened([turn("old")], "s1", "new")).toBe(false);
    expect(stepOpened([turn("new")], "s1", "new")).toBe(true);
    expect(stepOpened([turn()], "s1", "new")).toBe(true);
    expect(stepOpened([turn("new")], "s2", "new")).toBe(false);
  });
  it("names an answered card by the message it answered, and carries the refresh grant", () => {
    const history = turnHistory(view([reply(2, 4)]));
    const body = mentorTurnBody({ draftId: "d", stepId: "s1", purpose: "mentor", requestId: "r", input: "选A", organizeAfter: true,
      answerSource: { executionId: "turn:4", optionIndex: 1 }, researchRefreshId: "g" }, { sessionId: "x", moduleId: "m" }, history);
    expect(body).toMatchObject({ kind: "mentor", text: "选A", organizeAfter: true, answer: { sourceSeq: 2, optionIndex: 1 }, researchRefreshId: "g" });
  });
  it("streams text with code-point offsets and ends on the result", async () => {
    const seen = [];
    for await (const event of mentorTurnEvents({}, async (_body, onEvent) => {
      onEvent({ type: "opened", turnId: 7, reservedCredits: 1, replay: false });
      onEvent({ type: "text", delta: "好😀" }); onEvent({ type: "text", delta: "的" });
      const last = { type: "result", turnId: 7, body: "x", chargedCredits: 1, settlement: "done" } as const;
      onEvent(last); return { state: "finished", last };
    })) seen.push(event);
    expect(seen).toEqual([{ type: "admitted", executionId: "turn:7" }, { type: "textDelta", text: "好😀", offset: 0, rev: 1 },
      { type: "textDelta", text: "的", offset: 2, rev: 1 }, { type: "result", result: { state: "completed", executionId: "turn:7" } }]);
  });
  it("a refusal carries its notice; a dropped stream is the page's interrupted case", async () => {
    const drain = async (opener: Parameters<typeof mentorTurnEvents>[1]) => { for await (const _ of mentorTurnEvents({}, opener)) void _; };
    await expect(drain(async () => ({ state: "refused", code: "TURN_INSUFFICIENT_CREDITS", status: 200 }))).rejects.toBeInstanceOf(TurnRefused);
    await expect(drain(async () => ({ state: "lost" }))).rejects.toThrow(STREAM_INTERRUPTED);
  });
  it("keeps the calls of every page: a later page never drops an earlier reply's rows", async () => {
    const call = (turnId: number) => ({ turnId, seq: 2, toolName: "web_search", status: "ok", usage: {}, q: 100, multiplier: "6", arguments: null });
    const full = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, role: "user", turnId: 1, content: "" }));
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("afterSeq=0")
      ? { activeTurn: null, lastTurn: null, messages: full, calls: [call(1)] } : { activeTurn: null, lastTurn: null, messages: [], calls: [] })));
    expect((await readTurnView("s", fetcher as never))?.calls.map(c => c.turnId)).toEqual([1]);
  });
  it("keeps a turn id in the retained request, and recovery finds the saved reply by it", () => {
    const raw = JSON.stringify({ request: { draftId: "d", stepId: "s1", purpose: "mentor", requestId: "r1", input: "我做健身" } });
    const kept = envelopeWithExecution(raw, "r1", "turn:4");
    expect(kept).not.toBeNull();
    expect(parseStepEnvelope(kept!)?.executionId).toBe("turn:4");
    expect(envelopeWithExecution(raw, "r1", "turn:abc")).toBeNull();
    const history = turnHistory(view([{ seq: 1, role: "user", turnId: 4, content: "我做健身" }, reply(2, 4)]));
    expect(envelopeExecution(history as never, parseStepEnvelope(kept!)!)?.executionId).toBe("turn:4");
  });
  it("reads every page of saved messages", async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ seq: from + i, role: "user", turnId: 1, content: "" }));
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(view(url.endsWith("afterSeq=0") ? page(1, 50) : page(51, 3)))));
    expect((await readTurnView("s", fetcher as never))?.messages).toHaveLength(53);
  });
});
