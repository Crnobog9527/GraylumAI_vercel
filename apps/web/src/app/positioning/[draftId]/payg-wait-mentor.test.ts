/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { ORGANIZER_PENDING_NOTICE } from "@/lib/payg-wait";
import { admissionMessage } from "./admission-message";
import { mentorReplyDisplay } from "./agent-turn-display";
import { liveReplyController } from "./live-reply-controller";
import { isTerminalTurn, readAgentTurn, settleEnvelope, turnResultNotice, type MentorRequest } from "./mentor-turn";
import { envelopeRecovery, executionSettled, readStepEnvelopes, stepEnvelopeKey } from "./step-recovery";

/** BILL-PAYG pauses and Q1 refusals on the positioning mentor page. */
const draftId = "11111111-1111-4111-8111-111111111111";
const organizerId = "33333333-3333-4333-8333-333333333333";
const executionId = "55555555-5555-4555-8555-555555555555";
const request: MentorRequest = {
  draftId, stepId: "step-0", purpose: "mentor", requestId: "44444444-4444-4444-8444-444444444444", input: "我的新消息", questionId: "q",
};
const blocked = { admitted: false as const, blockedRequestId: request.requestId, executionId: organizerId,
  state: "waiting_credits" as const, code: "RUNTIME_WAITING_CREDITS" as const, cursor: 2, epoch: 1, remainingCalls: 1 };

async function* stream(events: AgentTurnEvent[]) {
  for (const event of events) yield event;
}
function store(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k), map };
}

describe("Q1: a new mentor message answered by the unfinished organizer", () => {
  it("is read as a result, not as an interrupted stream", async () => {
    const turn = await readAgentTurn(stream([{ type: "result", result: blocked }]), { onProgress: () => {} });
    expect(turn).toEqual({ executionId: organizerId, result: blocked });
  });

  it("still treats a stream without admitted or a Q1 result as interrupted", async () => {
    await expect(readAgentTurn(stream([{ type: "result", result: { state: "completed" } }]), { onProgress: () => {} }))
      .rejects.toThrow("OPC_EXECUTION_STREAM_INTERRUPTED");
  });

  it("releases its envelope (never stored on the server) even if the organizer still runs", () => {
    const key = stepEnvelopeKey(draftId, "step-0");
    const storage = store({ [key]: JSON.stringify({ request }) });
    expect(isTerminalTurn({ ...blocked, state: "pending" })).toBe(true);
    expect(settleEnvelope(storage, key, request.requestId, undefined, blocked)).toBe(true);
    expect(storage.map.has(key)).toBe(false);
  });

  it("leaves the notice to the page's pause notices instead of an error", () => {
    expect(turnResultNotice(blocked)).toBeNull();
    expect(turnResultNotice({ ...blocked, unavailable: "call_limited" })).toBeNull();
  });

  it("maps the RUNTIME_ORGANIZER_PENDING refusal to the fixed notice", () => {
    const cause = Object.assign(new Error("RUNTIME_ORGANIZER_PENDING：上一轮整理尚未完成，新消息尚未准入，请先处理原任务。"),
      { data: { code: "PRECONDITION_FAILED", path: "opc.mentorTurnStream" } });
    expect(admissionMessage(cause)).toBe(ORGANIZER_PENDING_NOTICE);
  });
});

describe("a paused mentor turn", () => {
  const source = { legacyMessage: "", active: false, busy: false };

  it("shows no unfinished-reply notice of its own (the pause notice replaces it)", () => {
    for (const state of ["waiting_credits", "waiting_resume"])
      expect(mentorReplyDisplay({ ...source, body: null, state })).toEqual({ text: "", card: null });
    expect(mentorReplyDisplay({ ...source, body: null, state: "interrupted" }).notice?.text).toBe("回复暂未完成，请继续核对。");
  });

  it("keeps a saved main reply visible while the organizer waits", () => {
    expect(mentorReplyDisplay({ ...source, body: "主回复正文", legacyMessage: "主回复正文", state: "waiting_credits" }).text).toBe("主回复正文");
  });

  it("settles a retained envelope and the live copy: only 继续 changes it", () => {
    const history = { activeExecution: null, executions: [{ executionId, state: "waiting_credits", request: { requestId: request.requestId } }] };
    const envelopes = readStepEnvelopes(store({ [stepEnvelopeKey(draftId, "step-0")]: JSON.stringify({ request, executionId }) }), draftId, ["step-0"]);
    expect(envelopeRecovery(history, envelopes[0], 0)).toBe("auto");
    expect(executionSettled(history, executionId)).toBe(true);
  });

  it("is not marked as an unfinished live reply when the stream ends paused", async () => {
    const shown: Array<{ phase: string } | null> = [];
    const live = liveReplyController({ draftId, storage: () => null, show: reply => shown.push(reply) });
    await live.stream(async () => stream([{ type: "admitted", executionId },
      { type: "result", result: { state: "waiting_credits", executionId, cursor: 1, epoch: 1, remainingCalls: 2 } }]), {});
    expect(live.current()?.phase).toBe("mentor");
    await live.stream(async () => stream([{ type: "admitted", executionId }, { type: "result", result: { state: "cancelled" } }]), {});
    expect(live.current()?.phase).toBe("incomplete");
  });
});
