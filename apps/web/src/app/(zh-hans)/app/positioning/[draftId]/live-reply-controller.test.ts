/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import type { LiveReply } from "./agent-turn-display";
import { liveReplyController } from "./live-reply-controller";
import { STREAM_INTERRUPTED } from "./mentor-turn";
import { autoContinueDecision, continuationAfterResult } from "@/components/research/research-session-model";

const draftId = "11111111-1111-4111-8111-111111111111";
const executionId = "33333333-3333-4333-8333-333333333333";

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key) };
}

function setup() {
  const shown: Array<LiveReply | null> = [];
  let clock = 0;
  const storage = memoryStorage();
  const live = liveReplyController({ draftId, storage: () => storage, show: reply => shown.push(reply), now: () => clock });
  return { live, shown, tick: (ms: number) => { clock += ms; } };
}

/** Events that arrive one by one, with fake time passing between them; `fail` ends the stream without a result. */
async function* turn(events: AgentTurnEvent[], tick: (ms: number) => void, gapMs: number, fail = false) {
  for (const event of events) {
    tick(gapMs);
    await Promise.resolve();
    yield event;
  }
  if (fail) throw new TypeError("network error");
}

const delta = (text: string, offset: number): AgentTurnEvent => ({ type: "textDelta", text, offset, rev: 1, source: "message" });
const completed = { admitted: true, state: "completed" } as unknown as AgentTurnOutcome;

describe("a long mentor turn in the live reply", () => {
  it("shows text and the result of a turn whose events are tens of seconds apart", async () => {
    const { live, shown, tick } = setup();
    const result = await live.stream(async () => turn([{ type: "admitted", executionId }, delta("好，", 0), delta("我去找对标。", 2),
      { type: "result", result: completed }], tick, 40_000), {});
    expect(result).toBe(completed);
    expect(live.streaming(executionId)).toBe(false);
    const last = shown.at(-1)!;
    expect(last.text).toBe("好，我去找对标。");
    expect(last.finished).toBe(true);
  });

  it("keeps the shown text as waiting when the stream drops, and gives way once history has the result", async () => {
    const { live, shown, tick } = setup();
    await expect(live.stream(async () => turn([{ type: "admitted", executionId }, delta("这一轮搜到了数据", 0)], tick, 30_000, true), {}))
      .rejects.toThrow("network error");
    expect(shown.at(-1)).toMatchObject({ executionId, text: "这一轮搜到了数据", phase: "waiting", stalled: true });
    // History polling then shows the execution terminal: the stored reply replaces the live copy.
    live.settle(executionId);
    expect(shown.at(-1)).toBeNull();
  });

  it("treats a stream that ends without a result as interrupted, never as finished", async () => {
    const { live, shown, tick } = setup();
    await expect(live.stream(async () => turn([{ type: "admitted", executionId }], tick, 90_000), {})).rejects.toThrow(STREAM_INTERRUPTED);
    expect(shown.at(-1)).toMatchObject({ executionId, phase: "waiting" });
  });

  it("hands the turn's own result to the observer after its research events, so auto-continue can arm", async () => {
    const seen: AgentTurnEvent[] = [];
    const storage = memoryStorage();
    let clock = 0;
    const live = liveReplyController({ draftId, storage: () => storage, show: () => undefined, now: () => clock,
      observe: (_id, event) => void seen.push(event) });
    const signal = { type: "research_continue", discoveryId: "d1" } as unknown as AgentTurnEvent;
    await live.stream(async () => turn([{ type: "admitted", executionId }, signal, delta("还在扩大搜索。", 0),
      { type: "result", result: completed }], ms => { clock += ms; }, 1000), {});
    expect(seen.map(event => event.type)).toEqual(["research_continue", "textDelta", "result"]);
    const result = (seen.at(-1) as Extract<AgentTurnEvent, { type: "result" }>).result;
    const continuation = { executionId, discoveryId: "d1" };
    expect(continuationAfterResult(continuation, executionId, result)).toEqual({ keep: true });
    expect(autoContinueDecision(continuation, new Set(), new Map(), false)).toBe("send");
  });
});
