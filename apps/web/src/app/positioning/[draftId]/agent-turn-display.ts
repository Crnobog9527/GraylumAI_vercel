/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  INVALID_REPLY_NOTICE,
  parseQuestionCard,
  readAgentTurnBody,
  type AgentTurnEvent,
  type QuestionCard,
} from "@repo/api/src/shared/agentTurn";

/** Shown instead of a body above the contract's parse limit. */
export const OVERSIZED_REPLY_NOTICE = "本次回复内容过长，页面暂时无法展示。原记录已保留，你可以继续对话。";

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

/** Status line under a streaming reply. `incomplete` is set by the page when the stream stops early. */
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
  /** This execution owns the server execution slot. */
  active: boolean;
  busy: boolean;
};

function unavailableNotice(source: MentorReplySource) {
  if (source.unavailableReason === "output_truncated")
    return "本次模型调用达到长度上限，未返回该阶段正文。原请求已保留，不会自动重试。";
  if (source.state === "cost_pending" && !source.active)
    return "本次执行已停止，费用仍待核实，原记录和预扣已保留。你可以继续讨论当前问题。";
  if (source.state === "cancelled")
    return "本次执行已停止，未取得可用回复。原记录已保留；请查看错误提示或继续讨论，系统不会自动重放这条请求。";
  return source.busy ? "正在回复…" : "回复暂未完成，请继续核对。";
}

/**
 * What one mentor message shows. Only the new envelope changes anything:
 * legacy JSON and plain bodies keep the existing parser's text, so saved
 * drafts look the same as before. Reasoning and raw JSON never reach the page.
 * `text` is empty only when a card is shown; a body without usable text or
 * card shows a fixed notice, never a blank.
 */
export function mentorReplyDisplay(source: MentorReplySource): { text: string; card: QuestionCard | null } {
  const body = readAgentTurnBody(source.body);
  const card = body.card ?? source.liveCard ?? null;
  if (source.liveText) return { text: source.liveText, card };
  // A valid envelope always has text, a card or both; a card alone needs no text.
  if (body.kind === "envelope") return { text: body.message, card };
  let stored = source.legacyMessage;
  if (body.kind === "invalid") stored = INVALID_REPLY_NOTICE;
  else if (body.kind === "oversized") stored = OVERSIZED_REPLY_NOTICE;
  return { text: stored || (card ? "" : unavailableNotice(source)), card };
}

/**
 * A card can be answered only on the newest turn. Any later turn, or a send
 * that is still waiting for the server, turns it into read-only history.
 * `nextInput` is the user's reply to it, or null when there was none (for
 * example a host-opened step).
 */
export function questionCardStatus(input: { isLatest: boolean; nextInput: string | null }) {
  return { answered: !input.isLatest || input.nextInput !== null, answer: input.nextInput };
}
