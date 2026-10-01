/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { OPENING_INPUT, openingRequestId } from "@repo/api/src/shared/opcQuestions";
import {
  STREAM_INTERRUPTED,
  envelopeAfterTurn,
  envelopeWithExecution,
  isTerminalTurn,
  openingRequest,
  parseStepEnvelope,
  readAgentTurn,
  retainExecution,
  settleEnvelope,
  turnResultNotice,
  type MentorRequest,
} from "./mentor-turn";

const draftId = "11111111-1111-4111-8111-111111111111";
const roundId = "22222222-2222-4222-8222-222222222222";
const executionId = "33333333-3333-4333-8333-333333333333";
const request: MentorRequest = {
  draftId,
  stepId: "audience",
  purpose: "mentor",
  requestId: "44444444-4444-4444-8444-444444444444",
  input: "我想帮助刚接触短视频的人",
  questionId: "who",
  organizeAfter: true,
};
const card = { question: "你的读者是谁？", options: ["新人", "同行"], recommended: null };

async function* stream(events: AgentTurnEvent[]) {
  for (const event of events) yield event;
}

describe("readAgentTurn", () => {
  it("reports admitted once, before any progress, then returns the result", async () => {
    const calls: string[] = [];
    const turn = await readAgentTurn(
      stream([
        { type: "admitted", executionId },
        { type: "phase", phase: "mentor" },
        { type: "text", text: "你好" },
        { type: "card", card },
        { type: "result", result: { state: "completed", body: "{}" } },
      ]),
      {
        onAdmitted: id => calls.push("admitted:" + id),
        onProgress: (id, event) => calls.push(event.type + ":" + id),
      },
    );
    expect(turn).toEqual({ executionId, result: { state: "completed", body: "{}" } });
    expect(calls).toEqual([
      "admitted:" + executionId,
      "phase:" + executionId,
      "text:" + executionId,
      "card:" + executionId,
    ]);
  });

  it("resumes a known execution without an admitted event", async () => {
    const onAdmitted = vi.fn();
    const onProgress = vi.fn();
    const turn = await readAgentTurn(
      stream([{ type: "text", text: "全文" }, { type: "result", result: { state: "pending" } }]),
      { executionId, onAdmitted, onProgress },
    );
    expect(turn.result.state).toBe("pending");
    expect(onAdmitted).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(executionId, { type: "text", text: "全文" });
  });

  it("never replaces a known execution id with another admitted id", async () => {
    const onAdmitted = vi.fn();
    const turn = await readAgentTurn(
      stream([
        { type: "admitted", executionId: "55555555-5555-4555-8555-555555555555" },
        { type: "result", result: { state: "completed" } },
      ]),
      { executionId, onAdmitted, onProgress: () => {} },
    );
    expect(turn.executionId).toBe(executionId);
    expect(onAdmitted).not.toHaveBeenCalled();
  });

  it("treats a stream that ends before admission as interrupted, with nothing to resume", async () => {
    const onAdmitted = vi.fn();
    await expect(readAgentTurn(stream([]), { onAdmitted, onProgress: () => {} })).rejects.toThrow(STREAM_INTERRUPTED);
    expect(onAdmitted).not.toHaveBeenCalled();
  });

  it("treats a stream that ends after admission but before the result as interrupted, after reporting the id", async () => {
    const onAdmitted = vi.fn();
    await expect(
      readAgentTurn(stream([{ type: "admitted", executionId }, { type: "text", text: "一半" }]), { onAdmitted, onProgress: () => {} }),
    ).rejects.toThrow(STREAM_INTERRUPTED);
    expect(onAdmitted).toHaveBeenCalledWith(executionId);
  });

  it("ignores progress that arrives before the execution is known", async () => {
    const onProgress = vi.fn();
    await readAgentTurn(
      stream([{ type: "text", text: "早到" }, { type: "admitted", executionId }, { type: "result", result: { state: "completed" } }]),
      { onProgress },
    );
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("passes a transport error through unchanged", async () => {
    const failure = Object.assign(new Error("当前账号没有可用的测试窗口"), { data: { code: "FORBIDDEN", path: "opc.mentorTurnStream" } });
    async function* broken(): AsyncGenerator<AgentTurnEvent> {
      yield* [];
      throw failure;
    }
    await expect(readAgentTurn(broken(), { onProgress: () => {} })).rejects.toBe(failure);
  });
});

describe("readAgentTurn onFinished", () => {
  it("runs exactly once after a completed turn, an interrupted stream and a transport error", async () => {
    const completed = vi.fn();
    await readAgentTurn(stream([{ type: "admitted", executionId }, { type: "result", result: { state: "completed" } }]), {
      onProgress: () => {},
      onFinished: completed,
    });
    expect(completed).toHaveBeenCalledTimes(1);

    const interrupted = vi.fn();
    await expect(readAgentTurn(stream([{ type: "admitted", executionId }]), { onProgress: () => {}, onFinished: interrupted })).rejects.toThrow(
      STREAM_INTERRUPTED,
    );
    expect(interrupted).toHaveBeenCalledTimes(1);

    const failed = vi.fn();
    async function* broken(): AsyncGenerator<AgentTurnEvent> {
      yield { type: "admitted", executionId };
      throw new Error("network");
    }
    await expect(readAgentTurn(broken(), { onProgress: () => {}, onFinished: failed })).rejects.toThrow("network");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("runs after the result has been read, so a settled charge is visible to the refresh", async () => {
    const order: string[] = [];
    await readAgentTurn(
      stream([{ type: "admitted", executionId }, { type: "result", result: { state: "completed" } }]),
      { onAdmitted: () => order.push("admitted"), onProgress: () => {}, onFinished: () => order.push("finished") },
    );
    expect(order).toEqual(["admitted", "finished"]);
  });
});

describe("parseStepEnvelope", () => {
  it("reads the current envelope, a pre-upgrade bare request and an admitted envelope", () => {
    expect(parseStepEnvelope(JSON.stringify({ request }))).toEqual({ request, information: undefined, editingSnapshot: undefined });
    expect(parseStepEnvelope(JSON.stringify(request))?.request).toEqual(request);
    expect(parseStepEnvelope(JSON.stringify({ request, executionId }))?.executionId).toBe(executionId);
  });

  it("keeps the information flush and editing snapshot", () => {
    const information = { draftId, stepId: "audience", requestId: request.requestId, expectedVersion: 3, values: {} };
    const parsed = parseStepEnvelope(JSON.stringify({ request, information, editingSnapshot: "null" }));
    expect(parsed).toMatchObject({ information, editingSnapshot: "null" });
  });

  it("ignores a malformed execution id and rejects unreadable envelopes", () => {
    expect(parseStepEnvelope(JSON.stringify({ request, executionId: "not-an-id" }))).not.toHaveProperty("executionId");
    expect(parseStepEnvelope("{broken")).toBeNull();
    expect(parseStepEnvelope(JSON.stringify({ request: { draftId } }))).toBeNull();
  });
});

describe("envelopeWithExecution", () => {
  it("adds the admitted execution id and keeps everything else verbatim", () => {
    const stored = JSON.stringify({ request, information: { a: 1 }, editingSnapshot: "x" });
    expect(JSON.parse(envelopeWithExecution(stored, request.requestId, executionId)!)).toEqual({
      request,
      information: { a: 1 },
      editingSnapshot: "x",
      executionId,
    });
  });

  it("wraps a pre-upgrade bare request", () => {
    expect(JSON.parse(envelopeWithExecution(JSON.stringify(request), request.requestId, executionId)!)).toEqual({ request, executionId });
  });

  it("never writes onto a released, replaced or unreadable envelope", () => {
    expect(envelopeWithExecution(null, request.requestId, executionId)).toBeNull();
    expect(envelopeWithExecution(JSON.stringify({ request: { ...request, requestId: "other" } }), request.requestId, executionId)).toBeNull();
    expect(envelopeWithExecution("{broken", request.requestId, executionId)).toBeNull();
    expect(envelopeWithExecution(JSON.stringify({ request }), request.requestId, "not-an-id")).toBeNull();
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("isTerminalTurn and envelopeAfterTurn", () => {
  it("treats only pending as still running", () => {
    expect(isTerminalTurn({ state: "pending" })).toBe(false);
    for (const state of ["completed", "cancelled", "cost_pending"] as const) expect(isTerminalTurn({ state })).toBe(true);
  });

  it("releases on a terminal outcome and keeps, with the execution id, on pending", () => {
    const stored = JSON.stringify({ request });
    expect(envelopeAfterTurn(stored, request.requestId, executionId, { state: "completed", body: "{}" })).toEqual({ release: true });
    expect(envelopeAfterTurn(stored, request.requestId, executionId, { state: "cost_pending" })).toEqual({ release: true });
    const kept = envelopeAfterTurn(stored, request.requestId, executionId, { state: "pending" });
    expect(kept.release).toBe(false);
    expect(JSON.parse((kept as { next: string }).next)).toEqual({ request, executionId });
  });

  it("keeps a pending envelope unchanged when the execution id is unknown or the envelope is someone else's", () => {
    const stored = JSON.stringify({ request });
    expect(envelopeAfterTurn(stored, request.requestId, undefined, { state: "pending" })).toEqual({ release: false, next: null });
    expect(envelopeAfterTurn(stored, "other", executionId, { state: "pending" })).toEqual({ release: false, next: null });
  });
});

describe("retainExecution and settleEnvelope", () => {
  const key = "opc-step:" + draftId + ":audience";

  it("records the admitted id, keeps the envelope while the execution runs, and releases it at a terminal result", () => {
    const storage = memoryStorage({ [key]: JSON.stringify({ request, editingSnapshot: "x" }) });
    retainExecution(storage, key, request.requestId, executionId);
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ request, editingSnapshot: "x", executionId });

    expect(settleEnvelope(storage, key, request.requestId, executionId, { state: "pending" })).toBe(false);
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ request, editingSnapshot: "x", executionId });
    // The next explicit resume reads the id back and resumes that execution.
    expect(parseStepEnvelope(storage.getItem(key)!)?.executionId).toBe(executionId);

    expect(settleEnvelope(storage, key, request.requestId, executionId, { state: "completed", body: "{}" })).toBe(true);
    expect(storage.getItem(key)).toBeNull();
  });

  it("writes the id on pending even when the admitted event was never stored", () => {
    const storage = memoryStorage({ [key]: JSON.stringify({ request }) });
    expect(settleEnvelope(storage, key, request.requestId, executionId, { state: "pending" })).toBe(false);
    expect(parseStepEnvelope(storage.getItem(key)!)?.executionId).toBe(executionId);
  });

  it("never touches an envelope that belongs to another request", () => {
    const other = JSON.stringify({ request: { ...request, requestId: "other" } });
    const storage = memoryStorage({ [key]: other });
    retainExecution(storage, key, request.requestId, executionId);
    expect(settleEnvelope(storage, key, request.requestId, executionId, { state: "pending" })).toBe(false);
    expect(settleEnvelope(storage, key, request.requestId, executionId, { state: "completed" })).toBe(true);
    expect(storage.getItem(key)).toBe(other);
  });
});

describe("openingRequest", () => {
  it("always carries the question id and the deterministic opening identity", () => {
    expect(openingRequest(draftId, roundId, "audience", "who")).toEqual({
      draftId,
      stepId: "audience",
      purpose: "mentor",
      requestId: openingRequestId(draftId, roundId, "audience", "who"),
      input: OPENING_INPUT,
      questionId: "who",
    });
  });

  it("gives a revision round its own opening identity", () => {
    const other = "66666666-6666-4666-8666-666666666666";
    expect(openingRequest(draftId, roundId, "audience", "who").requestId).not.toBe(openingRequest(draftId, other, "audience", "who").requestId);
  });
});

describe("turnResultNotice", () => {
  it("maps each unavailable reason that has a notice, and nothing else", () => {
    expect(turnResultNotice({ state: "completed", unavailable: "output_truncated" })).toContain("长度上限");
    expect(turnResultNotice({ state: "cancelled", unavailable: "provider_history" })).toContain("历史消息格式");
    expect(turnResultNotice({ state: "cancelled", unavailable: "preflight" })).toContain("派发前检查失败");
    expect(turnResultNotice({ state: "completed", body: "{}" })).toBeNull();
    expect(turnResultNotice({ state: "cancelled", unavailable: "capacity" })).toBeNull();
  });
});

import {sameRequest,releaseRejectedAnswer} from './mentor-turn';
it('matches a stopped request structurally including nested answerSource, retaining all identity differences',()=>{
 const request={requestId:'a',input:'乙',answerSource:{executionId:'source',optionIndex:1}};
 expect(sameRequest(request,JSON.parse(JSON.stringify(request)))).toBe(true);
 expect(sameRequest(request,{answerSource:{optionIndex:1,executionId:'source'},input:'乙',requestId:'a'})).toBe(true);
 for(const other of [{...request,answerSource:{executionId:'source',optionIndex:0}},
  {...request,input:'甲'},{...request,extra:true},{...request,answerSource:{executionId:'other',optionIndex:1}}])
  expect(sameRequest(request,other)).toBe(false);
});
it('definite source rejection releases its own envelope, unknown errors and other requests retain theirs',()=>{
 const values=new Map<string,string>();
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 const raw=JSON.stringify({request:{draftId:'d',stepId:'s',requestId:'a',input:'乙'}});
 storage.setItem('key',raw);
 expect(releaseRejectedAnswer(storage,'key','a',new Error('RUNTIME_ADMISSION_DENIED'))).toBe(false);
 expect(storage.getItem('key')).toBe(raw);
 expect(releaseRejectedAnswer(storage,'key','b',new Error('OPC_ANSWER_SOURCE_DENIED'))).toBe(true);
 expect(storage.getItem('key')).toBe(raw);
 expect(releaseRejectedAnswer(storage,'key','a',new Error('OPC_ANSWER_SOURCE_DENIED'))).toBe(true);
 expect(storage.getItem('key')).toBeNull();
});
