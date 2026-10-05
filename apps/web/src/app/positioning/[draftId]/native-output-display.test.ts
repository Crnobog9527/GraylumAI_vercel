/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { agentTurnBody, AGENT_TURN_MESSAGE_LIMIT, type AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { HISTORY_OMITTED_NOTICE } from "@/lib/runtime-gate-notice";
import {
  codePoints, LENGTH_LIMIT_NOTICE, livePhaseNotice, liveReplyAfter, mentorReplyDisplay, startLiveReply, type LiveReply,
  type MentorReplySource,
} from "./agent-turn-display";
import { isCompleteResult } from "./mentor-turn";
import { MENTOR_MESSAGE_LIMIT, readMentorTurn } from "./mentor-response";

const id = "00000000-0000-4000-8000-0000000000aa";
const delta = (text: string, offset: number, rev = 0): AgentTurnEvent => ({ type: "textDelta", text, offset, rev });
function run(events: AgentTurnEvent[], from: LiveReply = startLiveReply(id)) {
  return events.reduce<LiveReply | null>((reply, event) => liveReplyAfter(reply, id, event), from)!;
}

describe("textDelta consumer (CHAT-NATIVE-OUTPUT §2.2)", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(codePoints("中文")).toBe(2);
    expect(codePoints("a😀b")).toBe(3);
    expect(codePoints("\ud83d")).toBe(1);
    expect(codePoints("")).toBe(0);
  });

  it("appends a frame whose offset equals the shown code points, across emoji", () => {
    const reply = run([delta("你好😀", 0), delta("，世界", 3), delta("！", 6)]);
    expect(reply).toMatchObject({ text: "你好😀，世界！", points: 7, rev: 0, stalled: false });
  });

  it("replaces the whole text on an offset 0 snapshot and adopts its rev", () => {
    const reply = run([delta("助手文字", 0), delta("继续", 4), delta("卡片正文", 0, 1), delta("。", 4, 1)]);
    expect(reply).toMatchObject({ text: "卡片正文。", rev: 1, stalled: false });
  });

  it("drops a frame from another rev and stops growing until the next snapshot", () => {
    const stalled = run([delta("新来源", 0, 1), delta("旧增量", 3, 0)]);
    expect(stalled).toMatchObject({ text: "新来源", stalled: true });
    // Even a frame that would fit again is not appended once stalled.
    expect(run([delta("后续", 3, 1)], stalled)).toMatchObject({ text: "新来源", stalled: true });
    expect(run([delta("快照", 0, 2), delta("好", 2, 2)], stalled)).toMatchObject({ text: "快照好", rev: 2, stalled: false });
  });

  it("drops a gap or an overlap and stops growing", () => {
    expect(run([delta("abc", 0), delta("e", 4)])).toMatchObject({ text: "abc", stalled: true });
    expect(run([delta("abc", 0), delta("c", 2)])).toMatchObject({ text: "abc", stalled: true });
  });

  it("treats a malformed frame as a discontinuity", () => {
    const bad = { type: "textDelta", text: "x", offset: -1, rev: 0 } as AgentTurnEvent;
    expect(run([delta("abc", 0), bad])).toMatchObject({ text: "abc", stalled: true });
  });

  it("keeps the legacy whole-text event for executions without the new protocol", () => {
    const reply = run([{ type: "text", text: "旧" }, { type: "text", text: "旧格式全文" }]);
    expect(reply).toMatchObject({ text: "旧格式全文", points: 5 });
  });

  it("shows the card only from the card event after the text", () => {
    const card = { question: "选哪个？", options: ["A", "B"], recommended: 0 };
    const writing = run([delta("正文", 0)]);
    expect(writing.card).toBeNull();
    expect(run([{ type: "card", card }], writing)).toMatchObject({ text: "正文", card });
  });

  it("ignores events of another execution", () => {
    const reply = startLiveReply(id);
    expect(liveReplyAfter(reply, "00000000-0000-4000-8000-0000000000bb", delta("x", 0))).toBe(reply);
  });

  it("has a waiting notice", () => {
    expect(livePhaseNotice("waiting")).toBe("导师仍在回复，写完后会显示完整回复。");
  });
});

function source(body: string, extra: Partial<MentorReplySource> = {}): MentorReplySource {
  return { body, legacyMessage: readMentorTurn(body, new Set()).message, state: "completed", active: false, busy: false, ...extra };
}

describe("length limit (CHAT-NATIVE-OUTPUT §3.4)", () => {
  it("shows the truncation notice outside the reply text", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("写到一半", null), { completeness: "length_limit" }));
    expect(shown.text).toBe("写到一半");
    expect(shown.notice).toEqual({ tone: "warning", text: LENGTH_LIMIT_NOTICE });
  });

  it("adds the omitted-history note under it", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("写到一半", null), { completeness: "length_limit", historyOmitted: true }));
    expect(shown.notice?.text).toBe(LENGTH_LIMIT_NOTICE + "\n" + HISTORY_OMITTED_NOTICE);
  });

  it("shows nothing extra for a complete reply or a reply without metadata", () => {
    expect(mentorReplyDisplay(source(agentTurnBody("完整", null), { completeness: "complete" })).notice).toBeUndefined();
    expect(mentorReplyDisplay(source(agentTurnBody("旧回复", null))).notice).toBeUndefined();
  });

  it("does not show the notice over live text", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("x", null), { completeness: "length_limit", liveText: "正在写" }));
    expect(shown).toEqual({ text: "正在写", card: null });
  });

  it("refuses length_limit, compact and unorganized results as adoptable candidates", () => {
    expect(isCompleteResult({})).toBe(true);
    expect(isCompleteResult({ completeness: "complete", organized: true })).toBe(true);
    expect(isCompleteResult({ completeness: "length_limit" })).toBe(false);
    expect(isCompleteResult({ completeness: "complete", envelopeCompact: true })).toBe(false);
    expect(isCompleteResult({ completeness: "complete", organized: false })).toBe(false);
  });
});

describe("display limits", () => {
  it("reads a mentor message up to the stored result bound instead of 4000 characters", () => {
    const long = "长".repeat(9000);
    expect(readMentorTurn(JSON.stringify({ message: long }), new Set()).message).toBe(long);
    expect(MENTOR_MESSAGE_LIMIT).toBe(262144);
  });

  it("shows a native envelope above the shared 20000-character display limit in full", () => {
    const long = "x".repeat(AGENT_TURN_MESSAGE_LIMIT + 500);
    expect(mentorReplyDisplay(source(agentTurnBody(long, null, 262144))).text).toBe(long);
  });
});
