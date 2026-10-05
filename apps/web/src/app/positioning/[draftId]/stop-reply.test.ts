/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { agentTurnBody, type AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { liveReplyAfter, mentorReplyDisplay, startLiveReply, type LiveReply, type MentorReplySource } from "./agent-turn-display";
import { livePrefixKey, markLiveReload, takeLivePrefix } from "./live-prefix";
import { liveReplyController } from "./live-reply-controller";
import { mentorTailNotices, turnNeedsRetry } from "./mentor-notices";
import { isCompleteResult, isTerminalTurn } from "./mentor-turn";
import { envelopeRecovery, historyPollInterval, HISTORY_POLL_MS, type StoredStepEnvelope } from "./step-recovery";
import {
  sendStop, STOP_FOLLOW_UP_DELAYS_MS, STOP_SAVING_NOTICE, STOP_UNCONFIRMED_NOTICE, STOPPED_EMPTY_NOTICE, STOPPED_NOTICE, STOPPED_UNORGANIZED_NOTICE,
  stopFollowUpDelay, stopFollowUpTarget, stopRequestFor, stopSaving, userStopped,
} from "./stop-reply";

class TabStorage {
  items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

const executionId = "00000000-0000-4000-8000-0000000000bb";
let drafts = 0;
const newDraft = () => `stop-draft-${++drafts}`;
type Source = "assistant" | "message" | "final";
const delta = (text: string, offset: number, rev = 0, source?: Source): AgentTurnEvent =>
  ({ type: "textDelta", text, offset, rev, ...(source ? { source } : {}) });
const stored = (storage: TabStorage, draftId: string) => JSON.parse(storage.getItem(livePrefixKey(draftId)) ?? "null");
function controller(draftId: string, storage: TabStorage) {
  return liveReplyController({ draftId, storage: () => storage, show: () => undefined, now: () => 0 });
}
async function* events(list: AgentTurnEvent[]) {
  for (const event of list) yield event;
}
const stopBilling = { pausedReason: "user_stop", cancelRequested: false };

describe("stop request (CHAT-NATIVE-OUTPUT §4.2 C2)", () => {
  it("counts the shown text with Array.from, like the server's char_length", () => {
    const reply: LiveReply = { ...startLiveReply(executionId), text: "分析😀\n\nab", source: "assistant" };
    expect(stopRequestFor(reply)).toEqual({ executionId, stopAt: 7, source: "assistant" });
    expect(stopRequestFor(startLiveReply(executionId))).toEqual({ executionId, stopAt: 0 });
  });

  it("source follows the latest offset-0 snapshot only", () => {
    let reply = startLiveReply(executionId);
    for (const event of [delta("分析", 0, 0, "assistant"), delta("。", 2, 0)]) reply = liveReplyAfter(reply, executionId, event)!;
    expect(reply).toMatchObject({ text: "分析。", source: "assistant" });
    reply = liveReplyAfter(reply, executionId, delta("最终", 0, 1, "final"))!;
    expect(reply.source).toBe("final");
    // A snapshot without a known source (an older server) leaves none.
    reply = liveReplyAfter(reply, executionId, delta("旧", 0, 2))!;
    expect(reply.source).toBeUndefined();
    reply = liveReplyAfter(reply, executionId, delta("x", 0, 3, "bogus" as Source))!;
    expect(reply.source).toBeUndefined();
  });

  it("sendStop always carries stopAt, never sends an ordinary cancel, and maps the three answers", async () => {
    const request = { executionId, stopAt: 3, source: "assistant" as const };
    const cancel = vi.fn(async () => ({ state: "stopping" }));
    expect(await sendStop(request, cancel)).toBe("saving");
    expect(cancel).toHaveBeenCalledWith(request);
    // stopped_pending_result is rebuilt by the route: the answer is the final result.
    for (const state of ["completed", "cancelled", "cost_pending"])
      expect(await sendStop(request, async () => ({ state, stopped: true }))).toBe("settled");
    expect(await sendStop(request, async () => { throw new Error("network"); })).toBe("unconfirmed");
    const never = vi.fn();
    expect(await sendStop(null, never)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("stopping a live reply", () => {
  it("freezes the shown text at once: later text and a card are ignored", () => {
    const draftId = newDraft(), storage = new TabStorage(), live = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("已显示", 0, 0, "assistant"));
    expect(live.stop(executionId)).toEqual({ executionId, stopAt: 3, source: "assistant" });
    live.apply(executionId, delta("新字", 3));
    live.apply(executionId, { type: "card", card: { question: "问？", options: ["A", "B"], recommended: 0 } });
    live.apply(executionId, delta("替换", 0, 1, "final"));
    expect(live.current()).toMatchObject({ text: "已显示", stopped: true, card: null, source: "assistant" });
    // Stored at once, with its source, so a reload repeats the same request.
    expect(stored(storage, draftId)).toEqual({ executionId, text: "已显示", rev: 0, source: "assistant", stopped: true });
    // A second press sends nothing.
    expect(live.stop(executionId)).toBeNull();
    expect(live.stop("00000000-0000-4000-8000-0000000000cc")).toBeNull();
  });

  it("a reload restores the frozen reply and does not offer stop again", () => {
    const draftId = newDraft(), storage = new TabStorage(), live = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("分析", 0, 0, "assistant"));
    live.stop(executionId);
    live.pageHide();
    const restored = takeLivePrefix(storage, draftId);
    expect(restored).toMatchObject({ text: "分析", stopped: true, source: "assistant", phase: "waiting" });
    const next = controller(draftId, storage);
    next.restore();
    expect(next.stop(executionId)).toBeNull();
  });

  it("a stop pressed on a restored prefix uses the stored length and source", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, { ...startLiveReply(executionId), text: "刷新前😀", rev: 1, source: "message" });
    const live = controller(draftId, storage);
    live.restore();
    expect(live.stop(executionId)).toEqual({ executionId, stopAt: 4, source: "message" });
  });

  it("an empty reply that was stopped is still kept for a reload", () => {
    const draftId = newDraft(), storage = new TabStorage(), live = controller(draftId, storage);
    live.begin(executionId);
    expect(live.stop(executionId)).toEqual({ executionId, stopAt: 0 });
    live.pageHide();
    expect(takeLivePrefix(storage, draftId)).toMatchObject({ text: "", stopped: true });
  });

  it("a stopping result waits; a stopped reply is never marked incomplete and settles from history", async () => {
    const draftId = newDraft(), storage = new TabStorage(), live = controller(draftId, storage);
    await live.stream(async () => events([{ type: "admitted", executionId }, delta("写", 0, 0, "assistant"),
      { type: "result", result: { state: "stopping" } }]), {});
    expect(live.current()).toMatchObject({ text: "写", phase: "waiting" });
    live.stop(executionId);
    live.mark(executionId, "incomplete");
    expect(live.current()).toMatchObject({ text: "写", phase: "waiting", stopped: true });
    expect(stored(storage, draftId).text).toBe("写");
    live.settle(executionId);
    expect(live.current()).toBeNull();
  });

  it("knows which stream it reads, so the follow-up does not replay it", async () => {
    const draftId = newDraft(), live = controller(draftId, new TabStorage());
    let seen = false;
    async function* open() {
      yield { type: "admitted", executionId } as AgentTurnEvent;
      seen = live.streaming(executionId);
      yield { type: "result", result: { state: "completed" } } as AgentTurnEvent;
    }
    await live.stream(async () => open(), {});
    expect(seen).toBe(true);
    expect(live.streaming(executionId)).toBe(false);
  });
});

describe("a stopped turn while it saves", () => {
  const history = (state: string, billing: object | null = stopBilling) =>
    ({ activeExecution: executionId, executions: [{ executionId, state, billing, request: { requestId: "r1" } }] });

  it("interrupted and cost_pending are saving, not failed, and offer no retry", () => {
    for (const state of ["interrupted", "cost_pending", "running"]) {
      expect(stopSaving({ state, billing: stopBilling })).toBe(true);
      expect(turnNeedsRetry({ state, billing: stopBilling })).toBe(false);
    }
    expect(turnNeedsRetry({ state: "interrupted", billing: null })).toBe(true);
    expect(stopSaving({ state: "completed", billing: stopBilling })).toBe(false);
    // An ordinary cancellation owns the turn instead.
    expect(userStopped({ state: "cost_pending", billing: { pausedReason: "user_stop", cancelRequested: true } })).toBe(false);
  });

  it("never polls without end, recovers by itself or asks for the retry; the bounded follow-up drives it", () => {
    const envelope: StoredStepEnvelope = { stepId: "s", raw: "{}",
      parsed: { request: { requestId: "r1" }, executionId } as unknown as StoredStepEnvelope["parsed"] };
    for (const state of ["interrupted", "cost_pending"]) {
      expect(historyPollInterval(history(state), [], 0)).toBe(false);
      expect(historyPollInterval(history(state), [envelope], 0)).toBe(false);
      expect(envelopeRecovery(history(state), envelope, 60000)).toBe("stopped");
    }
    expect(envelopeRecovery(history("interrupted", null), envelope, 60000)).toBe("user");
    expect(historyPollInterval(history("running", null), [], 0)).toBe(HISTORY_POLL_MS);
  });

  it("shows the saving notice under the turn, never an error", () => {
    const base: MentorReplySource = { body: null, legacyMessage: "", state: "interrupted", active: true, busy: false, billing: stopBilling };
    for (const state of ["interrupted", "cost_pending"])
      expect(mentorReplyDisplay({ ...base, state }).notice).toEqual({ tone: "status", text: STOP_SAVING_NOTICE, busy: true });
    expect(mentorReplyDisplay({ ...base, state: "cancelled", active: false }).notice).toEqual({ tone: "status", text: STOPPED_EMPTY_NOTICE });
    // After the bounded follow-up gives up, the turn says the stop is not confirmed instead of spinning.
    expect(mentorReplyDisplay({ ...base, stopUnconfirmed: true }).notice).toEqual({ tone: "warning", text: STOP_UNCONFIRMED_NOTICE });
  });

  it("the tail notice offers 停止 only while the live reply can be stopped", () => {
    const ctx = { replying: false, lastTurnOpen: false, saving: false, recovery: null, error: "", notice: "", freeError: "" };
    const onClick = () => undefined;
    expect(mentorTailNotices({ ...ctx, livePhase: "mentor", stop: { onClick } })[0]?.actions?.[0]?.label).toBe("停止");
    expect(mentorTailNotices({ ...ctx, livePhase: "incomplete", stop: { onClick } })[0]?.actions).toBeUndefined();
    expect(mentorTailNotices({ ...ctx, livePhase: "stopped", stop: null })[0]).toMatchObject({ text: STOP_SAVING_NOTICE, busy: true });
    expect(mentorTailNotices({ ...ctx, livePhase: "stop_unconfirmed", stop: { onClick } })[0])
      .toEqual({ id: "live", tone: "warning", busy: false, text: STOP_UNCONFIRMED_NOTICE });
  });

  it("follows up only a saving turn this page does not stream, with growing delays and a limit", () => {
    const view = history("interrupted");
    expect(stopFollowUpTarget(view, () => false)).toBe(executionId);
    expect(stopFollowUpTarget(view, () => true)).toBeNull();
    expect(stopFollowUpTarget(history("completed"), () => false)).toBeNull();
    expect(stopFollowUpTarget(history("interrupted", null), () => false)).toBeNull();
    expect(STOP_FOLLOW_UP_DELAYS_MS.map((_, attempt) => stopFollowUpDelay(attempt))).toEqual(STOP_FOLLOW_UP_DELAYS_MS);
    // Bounded: about 7 minutes in all, beyond the server's 300 s wait, then no more reads.
    const total = STOP_FOLLOW_UP_DELAYS_MS.reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThan(300000);
    expect(total).toBeLessThanOrEqual(480000);
    expect(stopFollowUpDelay(STOP_FOLLOW_UP_DELAYS_MS.length)).toBeNull();
  });

  it("a stopping answer keeps the retained request; the saved result releases it", () => {
    expect(isTerminalTurn({ state: "stopping" })).toBe(false);
    expect(isTerminalTurn({ state: "completed", stopped: true })).toBe(true);
  });
});

describe("the saved result of a stopped turn", () => {
  const card = { question: "选哪个？", options: ["A", "B"], recommended: 0, message: "你更倾向哪个？", recommendationReason: "A 更稳" };
  const done = (body: string, extra: Partial<MentorReplySource>): MentorReplySource =>
    ({ body, legacyMessage: "", state: "completed", active: false, busy: false, billing: stopBilling, stopped: true, ...extra });

  it("a cut reply shows no card and says it stopped", () => {
    const shown = mentorReplyDisplay(done(agentTurnBody("分析到一半", card), { completeness: "stopped" }));
    expect(shown).toEqual({ text: "分析到一半", card: null, notice: { tone: "status", text: STOPPED_NOTICE } });
  });

  it("a reply stopped after it was fully shown keeps its card", () => {
    const shown = mentorReplyDisplay(done(agentTurnBody("分析。\n\n你更倾向哪个？", card), { completeness: "complete" }));
    expect(shown.card?.question).toBe("选哪个？");
    expect(shown.notice).toBeUndefined();
  });

  it("organized:false says 已停止，本轮未整理 under the reply", () => {
    const shown = mentorReplyDisplay(done(agentTurnBody("正文", null), { completeness: "complete", organized: false }));
    expect(shown.notice).toEqual({ tone: "status", text: STOPPED_UNORGANIZED_NOTICE });
    expect(STOPPED_UNORGANIZED_NOTICE).toBe("已停止，本轮未整理");
    expect(isCompleteResult({ completeness: "stopped" })).toBe(false);
  });
});

describe("analysis before a card stays (Owner decision A, §2.3)", () => {
  const card = { question: "选哪个？", options: ["A", "B"], recommended: 0, message: "你更倾向哪个？", recommendationReason: "A 更稳" };
  const message = "先分析你的情况：A 更稳。\n\n你更倾向哪个？";

  it("streams the analysis and appends the card's words without replacing them", () => {
    let reply = startLiveReply(executionId);
    for (const event of [delta("先分析你的情况：A 更稳。", 0, 0, "assistant"), delta("\n\n你更倾向哪个？", 13),
      { type: "card", card } as AgentTurnEvent]) reply = liveReplyAfter(reply, executionId, event)!;
    expect(reply).toMatchObject({ text: message, rev: 0, source: "assistant" });
  });

  it("after a reload the saved turn shows the same text, not only the card's words", () => {
    const shown = mentorReplyDisplay({ body: agentTurnBody(message, card), legacyMessage: "", state: "completed", active: false, busy: false });
    expect(shown.text).toBe(message);
    expect(shown.card?.question).toBe("选哪个？");
  });

  it("an older card turn, whose message was the card's words, looks the same as before", () => {
    const shown = mentorReplyDisplay({ body: agentTurnBody("你更倾向哪个？", card), legacyMessage: "", state: "completed", active: false, busy: false });
    expect(shown.text).toBe("你更倾向哪个？");
  });
});
