/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  INVALID_REPLY_NOTICE,
  parseQuestionCard,
  readAgentTurnBody,
  type AgentTurnEvent,
  type QuestionCard,
} from "@repo/api/src/shared/agentTurn";
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, PROVIDER_REJECTED_NOTICE, HISTORY_OMITTED_NOTICE } from "@/lib/runtime-gate-notice";
import { isPaygWaiting } from "@/lib/payg-wait";
import { STOP_SAVING_NOTICE, STOPPED_EMPTY_NOTICE, stoppedCut, stoppedResultNotice, stopSaving, userStopped } from "./stop-reply";

/** Under a reply that stopped at the single-answer length limit (completeness `length_limit`), outside its text. */
export const LENGTH_LIMIT_NOTICE = "这次回答达到单次长度上限，已在这里结束。需要的话，可以发送“继续”让我接着写。";

/** Shown instead of a body above the contract's parse limit. */
export const OVERSIZED_REPLY_NOTICE = "本次回复内容过长，页面暂时无法展示。原记录已保留，你可以继续对话。";

/** Accessible name of the positioning page's message box; the card's "其他" entry focuses it. */
export const MENTOR_REPLY_LABEL = "给导师的回复";

/** The card's fixed "其他" entry: move focus to the message box so the user answers in their own words. */
export function focusReply() {
  document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${MENTOR_REPLY_LABEL}"]`)?.focus();
}

/** Where the shown text comes from, as named by its latest snapshot (offset 0); the stop request repeats it. */
export type LiveTextSource = "assistant" | "message" | "final";

/**
 * Display-only progress of one streaming execution. Never business state.
 * `points` is the Unicode code point count of `text` (the unit of `textDelta`
 * offsets); `rev` is the snapshot revision the text belongs to. A `stalled`
 * reply stops growing until the next snapshot or the final result. `source`
 * comes from the latest snapshot. A `stopped` reply (the user pressed 停止)
 * ignores every later event until the saved result replaces it.
 */
export type LiveReply = {
  executionId: string; text: string; phase: string; card: QuestionCard | null;
  rev: number; points: number; stalled: boolean; source?: LiveTextSource; stopped?: boolean;
};

const knownPhases = new Set(["mentor", "reading", "organizer", "saving"]);

export function startLiveReply(executionId: string): LiveReply {
  return { executionId, text: "", phase: "mentor", card: null, rev: 0, points: 0, stalled: false };
}

/** Code points, the unit of `textDelta` offsets (a lone surrogate counts as one). */
export function codePoints(text: string) {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    // A high surrogate followed by a low one is one code point.
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Apply one `textDelta` (textDelta-v1). Offset 0 is a snapshot and replaces
 * the whole text. Any other frame is appended only when it continues the shown
 * text exactly (same `rev`, offset equal to the shown code points); otherwise
 * it is dropped and the reply stops growing until the next snapshot or result.
 */
const sources = new Set<unknown>(["assistant", "message", "final"]);

function afterDelta(old: LiveReply, event: { text: string; offset: number; rev: number; source?: unknown }): LiveReply {
  if (typeof event.text !== "string" || !isCount(event.offset) || !isCount(event.rev))
    return old.stalled ? old : { ...old, stalled: true };
  if (event.offset === 0) {
    const next: LiveReply = { ...old, text: event.text, points: codePoints(event.text), rev: event.rev, stalled: false };
    // A snapshot without a known source (an older server) leaves none: the stop then saves nothing (§4.2 e).
    if (sources.has(event.source)) next.source = event.source as LiveTextSource;
    else delete next.source;
    return next;
  }
  if (old.stalled) return old;
  if (event.rev !== old.rev || event.offset !== old.points) return { ...old, stalled: true };
  return { ...old, text: old.text + event.text, points: old.points + codePoints(event.text) };
}

/**
 * Apply one streamed event to the live reply of `executionId`. A legacy `text`
 * event carries the whole reply so far and replaces the shown text; a
 * `textDelta` follows `afterDelta`. Unknown phases and events are ignored, and
 * a streamed card is validated again because it is model output. A stopped
 * reply keeps exactly what was on screen when 停止 was pressed.
 */
export function liveReplyAfter(old: LiveReply | null, executionId: string, event: AgentTurnEvent): LiveReply | null {
  if (!old || old.executionId !== executionId || old.stopped) return old;
  if (event.type === "text") return { ...old, text: event.text, points: codePoints(event.text), stalled: false };
  if (event.type === "textDelta") return afterDelta(old, event);
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
  if (phase === "waiting") return "正在回复…";
  if (phase === "stopped") return STOP_SAVING_NOTICE;
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
  /** Result metadata of a native-output execution, when the history carries it. */
  completeness?: string;
  stopped?: boolean;
  organized?: boolean;
  /** The run's public billing view; `pausedReason: "user_stop"` marks a turn the user stopped. */
  billing?: { pausedReason?: string | null; cancelRequested?: boolean } | null;
  /** This execution owns the server execution slot. */
  active: boolean;
  busy: boolean;
};

/** A state notice shown under a mentor turn (inline notice), never as the message body. */
export type ReplyNotice = { tone: "status" | "warning"; text: string; busy?: boolean };

function unavailableNotice(source: MentorReplySource): ReplyNotice {
  // A stopped turn is saving what was shown, never failed, until its result is final.
  if (stopSaving(source)) return { tone: "status", text: STOP_SAVING_NOTICE, busy: true };
  if (source.state === "cancelled" && userStopped(source)) return { tone: "status", text: STOPPED_EMPTY_NOTICE };
  if (source.state === "cost_pending" && !source.active)
    return { tone: "warning", text: "本次执行已停止，费用仍待核实，原记录和预扣已保留。你可以继续讨论当前问题。" };
  if (source.state === "cancelled" && source.unavailableReason === "provider_rejected")
    return { tone: "warning", text: PROVIDER_REJECTED_NOTICE };
  if (source.state === "cancelled")
    return { tone: "warning", text: "本次执行已停止，未取得可用回复。原记录已保留；请查看错误提示或继续讨论，系统不会自动重放这条请求。" };
  return source.busy ? { tone: "status", text: "正在回复…", busy: true } : { tone: "warning", text: "回复暂未完成，请继续核对。" };
}

/**
 * A native-output envelope without a card may hold more than the shared display
 * limit (its size is bounded by the stored result instead); show all of it.
 */
function envelopeText(raw: string | null | undefined, body: ReturnType<typeof readAgentTurnBody>) {
  if (!body.truncated || body.card || !raw) return body.message;
  try {
    const message = (JSON.parse(raw) as { message?: unknown }).message;
    return typeof message === "string" ? message.trim() : body.message;
  } catch {
    return body.message;
  }
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
  const card = stoppedCut(source) ? null : body.card ?? source.liveCard ?? null;
  if (source.liveText) return { text: source.liveText, card, ...(historyNotice ? { notice: historyNotice } : {}) };
  const cut = source.unavailableReason === "output_truncated" ? OUTPUT_TRUNCATED_NOTICE
    : source.completeness === "length_limit" ? LENGTH_LIMIT_NOTICE : null;
  const stopped = stoppedResultNotice(source);
  const truncated: ReplyNotice | undefined = cut
    ? { tone: "warning", text: [cut, stopped, historyNotice?.text].filter(Boolean).join("\n") }
    : stopped ? { tone: "status", text: [stopped, historyNotice?.text].filter(Boolean).join("\n") } : undefined;
  const withNotice = (text: string, notice: ReplyNotice | undefined) => (notice ? { text, card, notice } : { text, card });
  // A valid envelope always has text, a card or both; a card alone needs no text.
  if (body.kind === "envelope") return withNotice(envelopeText(source.body, body), truncated ?? historyNotice);
  let stored = source.legacyMessage;
  if (body.kind === "invalid") stored = INVALID_REPLY_NOTICE;
  else if (body.kind === "oversized") stored = OVERSIZED_REPLY_NOTICE;
  // The turn's own state (正在回复…, 费用待核实, 已停止) comes first; the omitted-history note is added under it.
  // A BILL-PAYG pause carries its own notice and actions (payg-wait.ts).
  const state = stored || card || isPaygWaiting(source.state) ? undefined : unavailableNotice(source);
  const stateNotice = state && historyNotice ? { ...state, text: state.text + "\n" + historyNotice.text } : state ?? historyNotice;
  return withNotice(stored, truncated ?? stateNotice);
}

/**
 * True when `notice` reports the turn's own state, so the tail does not repeat "正在回复…".
 * The omitted-history note alone is not a state and never hides the tail's progress notice.
 */
export function showsTurnState(notice: ReplyNotice | undefined) {
  return Boolean(notice && notice.text !== HISTORY_OMITTED_NOTICE);
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
