/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  AGENT_TURN_BODY_LIMIT,
  INVALID_REPLY_NOTICE,
  agentTurnBody,
  type AgentTurnEvent,
} from "@repo/api/src/shared/agentTurn";
import {
  OVERSIZED_REPLY_NOTICE,
  liveReplyAfter,
  livePhaseNotice,
  mentorReplyDisplay,
  questionCardStatus,
  startLiveReply,
  type MentorReplySource,
} from "./agent-turn-display";
import { readWorkflowMentorExecution } from "./mentor-response";

const fields = { audience: { schema: [{ id: "who" }] } };
const card = { question: "你的内容主要写给谁？", options: ["刚入行的新人", "有经验的同行"], recommended: 0 };

function source(body: string | null, extra: Partial<MentorReplySource> = {}): MentorReplySource {
  const parsed = readWorkflowMentorExecution(body, null, "audience", fields);
  return { body, legacyMessage: parsed.message, state: "completed", active: false, busy: false, ...extra };
}

/** The page's display expression before this change, kept to prove legacy parity. */
function previousDisplay(s: MentorReplySource) {
  return s.liveText || s.legacyMessage ||
    (s.unavailableReason === "output_truncated"
      ? "本次模型调用达到长度上限，未返回该阶段正文。原请求已保留，不会自动重试。"
      : s.state === "cost_pending" && !s.active
      ? "本次执行已停止，费用仍待核实，原记录和预扣已保留。你可以继续讨论当前问题。"
      : s.state === "cancelled"
      ? "本次执行已停止，未取得可用回复。原记录已保留；请查看错误提示或继续讨论，系统不会自动重放这条请求。"
      : s.busy ? "正在回复…" : "回复暂未完成，请继续核对。");
}

describe("mentorReplyDisplay: new envelope", () => {
  it("shows the message and the card", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("先聊聊你的读者。", card)));
    expect(shown).toEqual({ text: "先聊聊你的读者。", card });
  });

  it("shows a card without text and without a fallback notice", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("", card)));
    expect(shown).toEqual({ text: "", card });
  });

  it("shows the message of an envelope without a card", () => {
    expect(mentorReplyDisplay(source(agentTurnBody("直接用文字提问：你的读者是谁？", null)))).toEqual({
      text: "直接用文字提问：你的读者是谁？",
      card: null,
    });
  });

  it("keeps the text and drops an invalid card", () => {
    const raw = JSON.stringify({ format: "agent-turn.v1", message: "正文仍然可读", card: { question: "?", options: ["只有一个"] } });
    expect(mentorReplyDisplay(source(raw))).toEqual({ text: "正文仍然可读", card: null });
  });

  it("shows the fixed notice when there is neither text nor a valid card", () => {
    const raw = JSON.stringify({ format: "agent-turn.v1", message: "  ", card: { question: "", options: [] } });
    expect(mentorReplyDisplay(source(raw))).toEqual({ text: INVALID_REPLY_NOTICE, card: null });
  });

  it("never shows raw JSON of an envelope", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("你好", card)));
    expect(shown.text).not.toContain("{");
    expect(shown.text).not.toContain("agent-turn.v1");
  });
});

describe("mentorReplyDisplay: every other body kind", () => {
  it("legacy JSON keeps the existing parser's text", () => {
    const raw = JSON.stringify({ message: "旧协议正文", inputKind: "answer", informationPatch: {} });
    expect(mentorReplyDisplay(source(raw))).toEqual({ text: "旧协议正文", card: null });
  });

  it("plain text keeps the existing parser's text", () => {
    expect(mentorReplyDisplay(source("早期的纯文本回复"))).toEqual({ text: "早期的纯文本回复", card: null });
  });

  it("an empty body falls back to the execution state", () => {
    expect(mentorReplyDisplay(source(null)).text).toBe("回复暂未完成，请继续核对。");
    expect(mentorReplyDisplay(source(null, { busy: true })).text).toBe("正在回复…");
    expect(mentorReplyDisplay(source(null, { state: "cancelled" })).text).toContain("本次执行已停止，未取得可用回复");
    expect(mentorReplyDisplay(source(null, { state: "cost_pending" })).text).toContain("费用仍待核实");
    expect(mentorReplyDisplay(source(null, { unavailableReason: "output_truncated" })).text).toContain("达到长度上限");
  });

  it("invalid content shows the fixed notice", () => {
    for (const raw of ["{broken", "```json\n{}", '{"inputKind":"answer"}', "[1,2]"])
      expect(mentorReplyDisplay(source(raw))).toEqual({ text: INVALID_REPLY_NOTICE, card: null });
  });

  it("an oversized body shows a notice instead of its content", () => {
    const raw = JSON.stringify({ message: "x".repeat(AGENT_TURN_BODY_LIMIT) });
    expect(mentorReplyDisplay(source(raw))).toEqual({ text: OVERSIZED_REPLY_NOTICE, card: null });
  });

  it("legacy bodies display exactly as before", () => {
    const bodies = [
      null,
      "",
      "   ",
      "纯文本回复",
      "null",
      '"a bare JSON string"',
      "123",
      "{broken",
      "[1]",
      JSON.stringify({ message: "旧协议正文", informationPatch: { who: { value: "新人", nature: "fact" } } }),
      JSON.stringify({ message: "x".repeat(5000) }),
      JSON.stringify({ message: "" }),
    ];
    const states: Array<Partial<MentorReplySource>> = [
      {},
      { busy: true },
      { state: "cancelled" },
      { state: "cost_pending" },
      { state: "cost_pending", active: true },
      { unavailableReason: "output_truncated" },
      { liveText: "流式中的全文" },
    ];
    for (const body of bodies)
      for (const extra of states) {
        const s = source(body, extra);
        expect(mentorReplyDisplay(s)).toEqual({ text: previousDisplay(s), card: null });
      }
  });
});

describe("mentorReplyDisplay: live stream", () => {
  it("prefers the streamed text and shows a streamed card before the body is saved", () => {
    const shown = mentorReplyDisplay(source(null, { liveText: "正在写的全文", liveCard: card }));
    expect(shown).toEqual({ text: "正在写的全文", card });
  });

  it("the saved card wins over a streamed one", () => {
    const other = { question: "另一个问题？", options: ["甲", "乙"], recommended: null };
    expect(mentorReplyDisplay(source(agentTurnBody("正文", card), { liveCard: other })).card).toEqual(card);
  });
});

describe("liveReplyAfter", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const apply = (events: AgentTurnEvent[], executionId = id) =>
    events.reduce((old, event) => liveReplyAfter(old, executionId, event), startLiveReply(id) as ReturnType<typeof liveReplyAfter>);

  it("replaces the text with each event instead of appending", () => {
    const live = apply([{ type: "text", text: "你" }, { type: "text", text: "你好" }, { type: "text", text: "你好，先说说" }]);
    expect(live?.text).toBe("你好，先说说");
  });

  it("ignores unknown phases and keeps known ones", () => {
    expect(apply([{ type: "phase", phase: "reading" }])?.phase).toBe("reading");
    expect(apply([{ type: "phase", phase: "organizer" }, { type: "phase", phase: "future" as never }])?.phase).toBe("organizer");
  });

  it("stores a valid card and ignores an invalid one", () => {
    expect(apply([{ type: "card", card }])?.card).toEqual(card);
    expect(apply([{ type: "card", card: { question: "?", options: ["一"] } as never }])?.card).toBeNull();
  });

  it("ignores admitted and events for another execution", () => {
    const start = startLiveReply(id);
    expect(liveReplyAfter(start, id, { type: "admitted", executionId: id })).toBe(start);
    expect(liveReplyAfter(start, "other", { type: "text", text: "x" })).toBe(start);
    expect(liveReplyAfter(null, id, { type: "text", text: "x" })).toBeNull();
  });
});

describe("livePhaseNotice", () => {
  it("maps each phase to a status line and unknown ones to the generating line", () => {
    expect(livePhaseNotice("organizer")).toContain("正在整理");
    expect(livePhaseNotice("saving")).toContain("正在保存");
    expect(livePhaseNotice("reading")).toContain("查阅");
    expect(livePhaseNotice("incomplete")).toContain("不会自动重发");
    expect(livePhaseNotice("mentor")).toBe(livePhaseNotice("anything"));
  });
});

describe("questionCardStatus", () => {
  type Binding = { roundId?: string | null; stepId?: string; questionId?: string | null };
  const turn = { roundId: "round-1", stepId: "audience", questionId: "who" };
  const shown = { roundId: "round-1", stepId: "audience", questionId: "who" };
  const reply = (input: string | null, binding: Binding = turn) => ({ ...binding, input });

  it("is open only on the newest turn without a pending reply", () => {
    expect(questionCardStatus({ isLatest: true, reply: null, turn, shown })).toEqual({
      answered: false,
      answer: null,
      onShownQuestion: true,
    });
  });

  it("becomes history once the user replied under its question or a later turn exists", () => {
    expect(questionCardStatus({ isLatest: true, reply: reply("刚入行的新人"), turn, shown })).toMatchObject({
      answered: true,
      answer: "刚入行的新人",
    });
    expect(questionCardStatus({ isLatest: false, reply: reply("自己写的回答"), turn, shown })).toMatchObject({
      answered: true,
      answer: "自己写的回答",
    });
    expect(questionCardStatus({ isLatest: false, reply: reply(null), turn, shown })).toMatchObject({ answered: true, answer: null });
  });

  it("never takes a turn sent under another round, step or question as its answer", () => {
    const elsewhere = [
      reply("刚入行的新人", { ...turn, roundId: "round-2" }),
      reply("刚入行的新人", { ...turn, stepId: "positioning" }),
      reply("刚入行的新人", { ...turn, questionId: "pain" }),
      reply("刚入行的新人", { stepId: "audience", questionId: "who" }),
      reply("刚入行的新人", {}),
    ];
    for (const next of elsewhere) {
      expect(questionCardStatus({ isLatest: false, reply: next, turn, shown })).toMatchObject({ answered: true, answer: null });
      // A send waiting under another question does not answer the newest card either.
      expect(questionCardStatus({ isLatest: true, reply: next, turn, shown })).toMatchObject({ answered: false, answer: null });
    }
  });

  it("is sendable only while its own question is on screen in its own round", () => {
    const status = (t: Binding | undefined, s = shown) =>
      questionCardStatus({ isLatest: true, reply: null, turn: t, shown: s }).onShownQuestion;
    expect(status(turn)).toBe(true);
    expect(status(turn, { ...shown, roundId: "round-2" })).toBe(false);
    expect(status(turn, { ...shown, stepId: "positioning" })).toBe(false);
    expect(status(turn, { ...shown, questionId: "pain" })).toBe(false);
    expect(status({ ...turn, questionId: null })).toBe(false);
    expect(status({ stepId: "audience", questionId: "who" })).toBe(false);
    expect(status(undefined)).toBe(false);
  });
});
