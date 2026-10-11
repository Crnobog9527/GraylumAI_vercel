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
  showsTurnState,
  startLiveReply,
  type MentorReplySource,
} from "./agent-turn-display";
import { readWorkflowMentorExecution } from "./mentor-response";
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, PROVIDER_REJECTED_NOTICE, HISTORY_OMITTED_NOTICE } from "@/lib/runtime-gate-notice";

const fields = { audience: { schema: [{ id: "who" }] } };
const card = { question: "你的内容主要写给谁？", options: ["刚入行的新人", "有经验的同行"], recommended: 0 };

function source(body: string | null, extra: Partial<MentorReplySource> = {}): MentorReplySource {
  const parsed = readWorkflowMentorExecution(body, null, "audience", fields);
  return { body, legacyMessage: parsed.message, state: "completed", active: false, busy: false, ...extra };
}

/**
 * The page's display before notices moved out of the message body: the same wording, now split
 * into the body text and one state notice under the turn. Truncation is always that notice.
 */
function previousDisplay(s: MentorReplySource) {
  if (s.liveText) return { text: s.liveText, card: null };
  const notice = s.unavailableReason === "output_truncated"
    ? { tone: "warning", text: OUTPUT_TRUNCATED_NOTICE }
    : s.legacyMessage ? undefined
    : s.state === "cost_pending" && !s.active
    ? { tone: "warning", text: "本次执行已停止，费用仍待核实，原记录和预扣已保留。你可以继续讨论当前问题。" }
    : s.state === "cancelled"
    ? { tone: "warning", text: "本次执行已停止，未取得可用回复。原记录已保留；请查看错误提示或继续讨论，系统不会自动重放这条请求。" }
    : s.busy ? { tone: "status", text: "正在回复…", busy: true } : { tone: "warning", text: "回复暂未完成，请继续核对。" };
  return notice ? { text: s.legacyMessage, card: null, notice } : { text: s.legacyMessage, card: null };
}

describe("mentorReplyDisplay: new envelope", () => {
  it("shows a deleted answer as unavailable, never incomplete or as stale streamed content", () => {
    for (const extra of [{}, { liveText: "已删除的旧正文", liveCard: card, busy: true, active: true }]) {
      expect(mentorReplyDisplay(source(null, { contentDeleted: true, ...extra }))).toEqual({
        text: "来源已不可用，暂不展示此内容。", card: null,
      });
    }
  });

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

  it("an empty body shows no text and one notice for the execution state", () => {
    const notice = (extra: Partial<MentorReplySource>) => mentorReplyDisplay(source(null, extra));
    expect(notice({})).toEqual({ text: "", card: null, notice: { tone: "warning", text: "回复暂未完成，请继续核对。" } });
    expect(notice({ busy: true }).notice).toEqual({ tone: "status", text: "正在回复…", busy: true });
    expect(notice({ state: "cancelled" }).notice?.text).toContain("本次执行已停止，未取得可用回复");
    expect(notice({ state: "cost_pending" }).notice?.text).toContain("费用仍待核实");
    expect(notice({ unavailableReason: "output_truncated" }).notice?.text).toBe(OUTPUT_TRUNCATED_NOTICE);
  });

  it("shows output truncation once, as the notice, even when the body has text", () => {
    const shown = mentorReplyDisplay(source(agentTurnBody("已写出的部分", null), { unavailableReason: "output_truncated" }));
    expect(shown).toEqual({ text: "已写出的部分", card: null, notice: { tone: "warning", text: OUTPUT_TRUNCATED_NOTICE } });
    expect(shown.text).not.toContain("长度上限");
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
        expect(mentorReplyDisplay(s)).toEqual(previousDisplay(s));
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


it('keeps provider_history on reload instead of showing a generic stopped message',()=>{
 const shown=mentorReplyDisplay(source(null,{state:'cancelled',unavailableReason:'provider_history'}));
 expect(shown.text).toBe('');expect(shown.card).toBeNull();
 expect(shown.notice?.text).toBe(PROVIDER_HISTORY_NOTICE);
 expect(shown.notice?.text).not.toContain('已停止');
});

it('keeps the older-history notice with a usable saved or live reply after reload',()=>{
 for(const body of [agentTurnBody('Saved answer',null),'Saved answer']) {
  const shown=mentorReplyDisplay(source(body,{historyOmitted:true}));
  expect(shown.text).toBe('Saved answer');expect(shown.notice).toEqual({tone:'status',text:HISTORY_OMITTED_NOTICE});
 }
 const live=mentorReplyDisplay(source(null,{liveText:'Live answer',historyOmitted:true}));
 expect(live.text).toBe('Live answer');expect(live.notice?.text).toBe(HISTORY_OMITTED_NOTICE);
});

it('keeps history omission visible alongside output truncation',()=>{
 const shown=mentorReplyDisplay(source(agentTurnBody('Partial answer',null),{
  historyOmitted:true,unavailableReason:'output_truncated',
 }));
 expect(shown.notice?.text).toContain(OUTPUT_TRUNCATED_NOTICE);
 expect(shown.notice?.text).toContain(HISTORY_OMITTED_NOTICE);
});

it('keeps the turn state ahead of the older-history notice when there is no reply yet', () => {
  const running = mentorReplyDisplay(source(null, { state: 'running', historyOmitted: true, active: true, busy: true }));
  expect(running.notice).toMatchObject({ tone: 'status', busy: true });
  expect(running.notice?.text.split('\n')).toEqual(['正在回复…', HISTORY_OMITTED_NOTICE]);
  const cost = mentorReplyDisplay(source(null, { state: 'cost_pending', historyOmitted: true }));
  expect(cost.notice?.tone).toBe('warning');
  expect(cost.notice?.text).toContain('费用仍待核实');
  expect(cost.notice?.text).toContain(HISTORY_OMITTED_NOTICE);
  expect(showsTurnState(running.notice)).toBe(true);
});

it('does not let the older-history notice alone hide the tail progress notice', () => {
  const shown = mentorReplyDisplay(source(agentTurnBody('Saved answer', null), { historyOmitted: true }));
  expect(showsTurnState(shown.notice)).toBe(false);
  expect(showsTurnState(undefined)).toBe(false);
  expect(showsTurnState({ tone: 'warning', text: OUTPUT_TRUNCATED_NOTICE })).toBe(true);
});
it('keeps the provider refusal notice for a cancelled turn without a body after a reload', () => {
 expect(mentorReplyDisplay(source(null,{state:'cancelled',unavailableReason:'provider_rejected'})))
  .toEqual({text:'',card:null,notice:{tone:'warning',text:PROVIDER_REJECTED_NOTICE}});
 for (const unavailableReason of ['something_new',null])
  expect(mentorReplyDisplay(source(null,{state:'cancelled',unavailableReason})).notice?.text).toContain('本次执行已停止，未取得可用回复');
 const omitted=mentorReplyDisplay(source(null,{state:'cancelled',unavailableReason:'provider_rejected',historyOmitted:true}));
 expect(omitted.notice?.text).toBe(PROVIDER_REJECTED_NOTICE+'\n'+HISTORY_OMITTED_NOTICE);
});
