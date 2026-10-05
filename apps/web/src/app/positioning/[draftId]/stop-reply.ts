/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LiveReply, LiveTextSource } from "./agent-turn-display";

/**
 * Stopping a mentor reply (CHAT-NATIVE-OUTPUT §4.2 C2). 停止 freezes what is on
 * screen and asks the server to save exactly that: `stopAt` is the number of
 * code points shown (Array.from, the server's char_length) and `source` is the
 * source of the latest snapshot. The server rebuilds the saved reply from the
 * provider receipt; the page then shows that saved reply. Once a stop is
 * recorded the page never sends an ordinary cancel for the same turn: that
 * would move it onto the cancellation path and save nothing.
 */
export const STOP_SAVING_NOTICE = "已停止，正在保存已显示的内容…";
export const STOPPED_NOTICE = "已停止，保留了停止前显示的内容。";
export const STOPPED_UNORGANIZED_NOTICE = "已停止，本轮未整理";
export const STOPPED_EMPTY_NOTICE = "已停止，本轮没有保存回复。";
export const STOP_UNCONFIRMED_NOTICE = "停止请求暂未确认。已显示的内容保留，请稍后查看这条回复的结果，不会重复扣费。";

export type StopRequest = { executionId: string; stopAt: number; source?: LiveTextSource };

/** The stop request for what `reply` shows now. */
export function stopRequestFor(reply: LiveReply): StopRequest {
  return { executionId: reply.executionId, stopAt: Array.from(reply.text).length, ...(reply.source ? { source: reply.source } : {}) };
}

type StopView = {
  state: string;
  /** runtime_view: a user stop is recorded and its result is not saved yet (every billing version). */
  userStopPending?: boolean;
  billing?: { pausedReason?: string | null; cancelRequested?: boolean } | null;
};

/**
 * The server recorded a user stop for this execution and has not saved its
 * result yet. `userStopPending` is the signal; only a history without that
 * field falls back to the pause reason, which runtime_view shows for
 * bill2.v2 runs alone.
 */
export function userStopped(execution: StopView | null | undefined) {
  if (!execution) return false;
  if (typeof execution.userStopPending === "boolean") return execution.userStopPending;
  return execution.billing?.pausedReason === "user_stop" && execution.billing.cancelRequested !== true;
}

/**
 * A stopped turn whose saved result is not final yet. It may pass through
 * `interrupted` and `cost_pending` before `completed`; meanwhile it is saving,
 * not failed, and offers no retry.
 */
export function stopSaving(execution: StopView | null | undefined) {
  return userStopped(execution) && !["completed", "cancelled"].includes(execution!.state);
}

/**
 * Executions this tab stopped, so a stop that saved nothing (`cancelled`)
 * still reads as stopped after `userStopPending` turns false. Display only,
 * in this tab's sessionStorage; another tab shows the ordinary cancelled notice.
 */
export function stoppedHereKey(draftId: string) {
  return "opc-stopped:" + draftId;
}
const STOPPED_HERE_LIMIT = 20;
type TabStore = Pick<Storage, "getItem" | "setItem">;

export function stoppedHere(storage: TabStore | null, draftId: string): string[] {
  try {
    const value = JSON.parse(storage?.getItem(stoppedHereKey(draftId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function rememberStop(storage: TabStore | null, draftId: string, executionId: string) {
  const ids = [...stoppedHere(storage, draftId).filter(id => id !== executionId), executionId].slice(-STOPPED_HERE_LIMIT);
  try {
    storage?.setItem(stoppedHereKey(draftId), JSON.stringify(ids));
  } catch {
    /* Without storage only the notice of a stop that saved nothing is lost. */
  }
}

/**
 * 停止 is offered on a live reply until a result is final, including the
 * `saving` phase just before the result is stored: a stop recorded then still
 * cuts the saved text at `stopAt`. Not on a reply already stopped (here or as
 * history shows), one whose stream already delivered its final result, or
 * one that ended without a result.
 */
export function stopAvailable(reply: LiveReply | null, recorded: StopView | undefined, settled: boolean) {
  return Boolean(reply && !reply.stopped && !reply.finished && reply.phase !== "incomplete" && !settled && !stopSaving(recorded));
}

/** True when a `runtime.cancel` stop answer still waits for the in-flight call (`stopping`). */
export function stopStillSaving(response: unknown) {
  return Boolean(response && typeof response === "object" && (response as { state?: unknown }).state === "stopping");
}

/**
 * When the page that stopped no longer reads the original stream (a reload, a
 * lost connection), it re-reads the stopped execution so the server can
 * rebuild the result from the receipt. Never a new provider call. The reads
 * are bounded: about 7 minutes in all, past the server's 300-second wait for
 * the in-flight call. After the last one the page stops reading by itself and
 * says the stop is not confirmed yet (STOP_UNCONFIRMED_NOTICE).
 */
export const STOP_FOLLOW_UP_DELAYS_MS = [3000, 10000, 20000, 30000, 60000, 60000, 60000, 60000, 60000, 60000];

/** Delay before re-read `attempt` (0-based), or null once the reads are used up. */
export function stopFollowUpDelay(attempt: number) {
  return STOP_FOLLOW_UP_DELAYS_MS[attempt] ?? null;
}

/** The notice of a stopped reply's saved result, or null. A cut reply never keeps its card. */
export function stoppedResultNotice(result: { stopped?: boolean; completeness?: string; organized?: boolean }) {
  if (result.stopped !== true) return null;
  if (result.organized === false) return STOPPED_UNORGANIZED_NOTICE;
  return result.completeness === "stopped" ? STOPPED_NOTICE : null;
}

/** A stopped reply that was cut before its end shows no question card. */
export function stoppedCut(result: { stopped?: boolean; completeness?: string }) {
  return result.stopped === true && result.completeness === "stopped";
}

/**
 * Send one stop. The request always carries `stopAt`, so the server records a
 * stop (or, for a turn that cannot save its text, keeps its old cancellation);
 * it is never an ordinary cancel. Returns what the page shows next:
 * `saving` while the in-flight call is still writing, `settled` when the answer
 * already holds the final result, `unconfirmed` when the request failed.
 */
export async function sendStop(request: StopRequest | null, cancel: (request: StopRequest) => Promise<unknown>) {
  if (!request) return null;
  try {
    return stopStillSaving(await cancel(request)) ? "saving" as const : "settled" as const;
  } catch {
    return "unconfirmed" as const;
  }
}

/** A stopped turn still saving whose stream this page does not read: it is re-read to let the server finish it. */
export function stopFollowUpTarget(
  history: { executions?: Array<StopView & { executionId: string }> | null } | undefined,
  streaming: (executionId: string) => boolean,
) {
  return history?.executions?.find(execution => stopSaving(execution) && !streaming(execution.executionId))?.executionId ?? null;
}
