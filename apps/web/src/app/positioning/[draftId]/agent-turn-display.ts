/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  INVALID_REPLY_NOTICE,
  parseQuestionCard,
  readAgentTurnBody,
  type AgentTurnEvent,
  type QuestionCard,
} from "@repo/api/src/shared/agentTurn";
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, HISTORY_OMITTED_NOTICE } from "@/lib/runtime-gate-notice";

/** Shown instead of a body above the contract's parse limit. */
export const OVERSIZED_REPLY_NOTICE = "本次回复内容过长，页面暂时无法展示。原记录已保留，你可以继续对话。";

/** Accessible name of the positioning page's message box; the card's "其他" entry focuses it. */
export const MENTOR_REPLY_LABEL = "给导师的回复";

/** The card's fixed "其他" entry: move focus to the message box so the user answers in their own words. */
export function focusReply() {
  document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${MENTOR_REPLY_LABEL}"]`)?.focus();
}

/** Display-only progress of one streaming execution. Never business state. */
export type LiveReply = { executionId: string; text: string; phase: string; card: QuestionCard | null };

const knownPhases = new Set(["mentor", "reading", "organizer", "saving"]);

export function startLiveReply(executionId: string): LiveReply {
  return { executionId, text: "", phase: "mentor", card: null };
}

/**
 * Apply one streamed event to the live reply of `executionId`. A `text` event
 * carries the whole reply so far and replaces the shown text. Unknown phases
 * and events are ignored, and a streamed card is validated again because it is
 * model output.
 */
export function liveReplyAfter(old: LiveReply | null, executionId: string, event: AgentTurnEvent): LiveReply | null {
  if (!old || old.executionId !== executionId) return old;
  if (event.type === "text") return { ...old, text: event.text };
  if (event.type === "phase") return knownPhases.has(event.phase) ? { ...old, phase: event.phase } : old;
  if (event.type === "card") return { ...old, card: parseQuestionCard(event.card) ?? old.card };
  return old;
}

/** Status notice under a streaming reply. `incomplete` is set by the page when the stream stops early. */
export function livePhaseNotice(phase: string) {
  if (phase === "reading") return "正在查阅方法资料…";
  if (phase === "organizer") return "正文已返回，正在整理待核对信息…";
  if (phase === "saving") return "正在保存结果并核对费用…";
  if (phase === "incomplete") return "回复尚未完成；原请求已保留，请按当前状态继续核对，不会自动重发。";
  return "正在生成；部分正文尚未完成，费用尚未结算。";
}

export type MentorReplySource = {
  /** Stored reply body of the execution. */
  body: string | null | undefined;
  /** Text from the existing mentor parser; legacy bodies keep showing exactly this. */
  legacyMessage: string;
  /** Latest streamed text for this execution, if it is streaming now. */
  liveText?: string;
  liveCard?: QuestionCard | null;
  state: string;
  unavailableReason?: string | null;
  historyOmitted?: boolean;
  /** This execution owns the server execution slot. */
  active: boolean;
  busy: boolean;
};

/** A state notice shown under a mentor turn (inline notice), never as the message body. */
export type ReplyNotice = { tone: "status" | "warning"; text: string; busy?: boolean };

function unavailableNotice(source: MentorReplySource): ReplyNotice {
  if (source.state === "cost_pending" && !source.active)
    return { tone: "warning", text: "本次执行已停止，费用仍待核实，原记录和预扣已保留。你可以继续讨论当前问题。" };
  if (source.state === "cancelled")
    return { tone: "warning", text: "本次执行已停止，未取得可用回复。原记录已保留；请查看错误提示或继续讨论，系统不会自动重放这条请求。" };
  return source.busy ? { tone: "status", text: "正在回复…", busy: true } : { tone: "warning", text: "回复暂未完成，请继续核对。" };
}

/**
 * What one mentor message shows. Only the new envelope changes anything:
 * legacy JSON and plain bodies keep the existing parser's text, so saved
 * drafts look the same as before. Reasoning and raw JSON never reach the page.
 * A body without usable text or card shows no text and one state `notice`;
 * output truncation is always that one notice, shown once under the turn.
 */
export function mentorReplyDisplay(source: MentorReplySource): { text: string; card: QuestionCard | null; notice?: ReplyNotice } {
  if (source.unavailableReason === "provider_history")
    return { text: "", card: null, notice: { tone: "warning", text: PROVIDER_HISTORY_NOTICE } };
  const historyNotice: ReplyNotice | undefined = source.historyOmitted
    ? { tone: "status", text: HISTORY_OMITTED_NOTICE } : undefined;
  const body = readAgentTurnBody(source.body);
  const card = body.card ?? source.liveCard ?? null;
  if (source.liveText) return { text: source.liveText, card, ...(historyNotice ? { notice: historyNotice } : {}) };
  const truncated: ReplyNotice | undefined =
    source.unavailableReason === "output_truncated"
      ? { tone: "warning", text: [OUTPUT_TRUNCATED_NOTICE, historyNotice?.text].filter(Boolean).join("\n") } : undefined;
  const withNotice = (text: string, notice: ReplyNotice | undefined) => (notice ? { text, card, notice } : { text, card });
  // A valid envelope always has text, a card or both; a card alone needs no text.
  if (body.kind === "envelope") return withNotice(body.message, truncated ?? historyNotice);
  let stored = source.legacyMessage;
  if (body.kind === "invalid") stored = INVALID_REPLY_NOTICE;
  else if (body.kind === "oversized") stored = OVERSIZED_REPLY_NOTICE;
  return withNotice(stored, truncated ?? historyNotice ?? (stored || card ? undefined : unavailableNotice(source)));
}

/** Where a turn was asked: a revision opens a new round that reuses step and question ids. */
type TurnBinding = { roundId?: string | null; stepId?: string; questionId?: string | null };

function sameQuestion(a: TurnBinding | null | undefined, b: TurnBinding | null | undefined) {
  return Boolean(a?.roundId && a.stepId && a.questionId && a.roundId === b?.roundId && a.stepId === b?.stepId && a.questionId === b?.questionId);
}

/**
 * A card can be answered only on the newest turn. Any later turn turns it
 * into read-only history, and so does a send still waiting for the server.
 * `reply` is that later turn (or the waiting send). It counts as the card's
 * answer only when it was sent under the card's own round, step and question;
 * a host-opened step (`input: null`) or a turn for another question or round
 * closes the card without an answer.
 *
 * A reply is recorded against the question on screen in the current round, so
 * the card is only sendable while that is the question its turn was asked
 * under; after the user navigates elsewhere, or a revision starts a new round,
 * it stays visible but locked.
 */
export function questionCardStatus(input: {
  isLatest: boolean;
  reply: (TurnBinding & { input: string | null }) | null;
  turn: TurnBinding | undefined;
  shown: { roundId: string | null; stepId: string; questionId: string };
}) {
  const answer = input.reply && sameQuestion(input.reply, input.turn) ? input.reply.input : null;
  return {
    answered: !input.isLatest || answer !== null,
    answer,
    onShownQuestion: sameQuestion(input.turn, input.shown),
  };
}
