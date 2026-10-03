/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CHAT_ACTION, type ChatNotice } from "@/components/chat/ChatInlineNotice";
import { livePhaseNotice, type ReplyNotice } from "./agent-turn-display";

/** The failed explicit retry of a retained request; the retry notice already says the same. */
export const RETRY_PENDING_NOTICE = "原请求仍未确认结果，已继续保留。请稍后再点“重试”，不会重复发送或重复扣费。";

type Action = { onClick: () => void; disabled?: boolean };

/**
 * Notices under the last mentor turn, in the conversation: stream progress, the pending reply,
 * unsaved form edits, the retry of a retained request, and the page's error and notice.
 * One event is one notice: "正在回复…" only when no open turn or live stream already says so,
 * and a failed retry's error is not repeated under its retry notice.
 */
export function mentorTailNotices(ctx: {
  livePhase: string | null;
  replying: boolean;
  /** The last turn already shows its own state notice (for example 正在回复…). */
  lastTurnOpen: boolean;
  saving: boolean;
  recovery: (Action & { readable: boolean }) | null;
  error: string;
  notice: string;
  freeError: string;
}): ChatNotice[] {
  const notices: ChatNotice[] = [];
  if (ctx.livePhase) {
    const incomplete = ctx.livePhase === "incomplete";
    notices.push({ id: "live", tone: incomplete ? "warning" : "status", busy: !incomplete, text: livePhaseNotice(ctx.livePhase) });
  } else if (ctx.replying && !ctx.lastTurnOpen) notices.push({ id: "replying", tone: "status", busy: true, text: "正在回复…" });
  if (ctx.saving) notices.push({ id: "saving", tone: "status", text: "正在保存最新修改。保存完成前不会确认步骤或采用计划。" });
  if (ctx.recovery)
    notices.push({ id: "recovery", tone: "warning", label: "恢复提示",
      text: ctx.recovery.readable ? "上一条回复还没确认完成，原请求已保留，重试不会重复扣费。" : "上一条请求无法读取，原始记录已保留。",
      actions: [{ label: CHAT_ACTION.retry, onClick: ctx.recovery.onClick, disabled: ctx.recovery.disabled }] });
  if (ctx.error && !(ctx.recovery && ctx.error === RETRY_PENDING_NOTICE)) notices.push({ id: "error", tone: "error", text: ctx.error });
  if (ctx.notice) notices.push({ id: "notice", tone: "warning", text: ctx.notice });
  if (ctx.freeError) notices.push({ id: "free", tone: "error", text: ctx.freeError });
  return notices;
}

/** The notice under one mentor turn; a turn that stopped advancing carries its "重试". */
export function mentorTurnNotice(id: string, reply: ReplyNotice | undefined, stalled: Action | null): ChatNotice | null {
  const base = reply ?? (stalled ? { tone: "warning" as const, text: "回复暂未完成，请继续核对。" } : null);
  if (!base) return null;
  return { id, ...base, ...(stalled ? { actions: [{ label: CHAT_ACTION.retry, ...stalled }] } : {}) };
}
