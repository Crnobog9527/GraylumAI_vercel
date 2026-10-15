/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CHAT_ACTION, type ChatNotice } from '@/components/chat/ChatInlineNotice';
import { OUTPUT_TRUNCATED_NOTICE, PLATFORM_FAILURE_NOTICE, PROVIDER_HISTORY_NOTICE, PROVIDER_REJECTED_NOTICE,
  HISTORY_OMITTED_NOTICE } from '@/lib/runtime-gate-notice';
import { isPaygWaiting, organizerSkipped, type PaygViewFields } from '@/lib/payg-wait';
import { POSITIONING_REQUIRED_NOTICE, forgetUserStop, rememberUserStop } from './gate-notices';
import { positioningRequiredNotice } from './positioning-required';

/** A frozen guidance request without its execution, waiting for the user's explicit retry. */
export const GUIDE_HELD_NOTICE = '引导请求待恢复。点“重试”会沿用原请求，不会另开一次。';
/** Shown only for a stop the user asked for in this browser. */
export const USER_STOP_NOTICE = '已停止，保留原记录。';
/**
 * Any other cancelled turn: the server ended it (provider refusal, moderation, a failed or timed-out
 * call, an unfinished financial recovery). It is not a stop the user asked for, so it never says 已停止.
 */
export const ENDED_NOTICE = '这一轮没有完成，已结束。原记录已保留，不会自动重试；可以重新发送。';
export const CAPACITY_NOTICE = '本次必要材料超过模型输入容量，原请求和已完成内容已保留。停止后可缩短材料再新发请求。';

/** What runtime_view says about a user stop (0171/0172): pending, saved (`stopped`), or the v2 pause reason. */
export type StopSignals = {
  userStopPending?: boolean; stopped?: boolean;
  billing?: { pausedReason?: string | null; cancelRequested?: boolean } | null;
};

export type RuntimeTurn = PaygViewFields & StopSignals & {
  executionId: string; state: string; primaryBody: string | null; organizerComplete: boolean | null;
  needsTask: boolean; unavailableReason: string | null; historyOmitted?: boolean;
};

/**
 * The user stopped this round: this tab's own record, or the server's record of a user stop.
 * A stop that keeps the shown text ends `completed` with pausedReason `user_stop` (#973), so the
 * final state alone never says whether the user stopped it.
 */
export function stoppedByUser(turn: StopSignals, local?: boolean) {
  return Boolean(local || turn.userStopPending || turn.stopped === true
    || (turn.billing?.pausedReason === 'user_stop' && turn.billing.cancelRequested !== true));
}

/**
 * After a failed stop request, the re-read view proves the server recorded neither a stop nor a
 * cancellation: the round is still open with no stop or cancel signal. Only then may the page drop
 * this tab's stop record. A lost re-read (no turn) or any recorded stop keeps it.
 */
export function stopNotRecorded(turn: (StopSignals & { state: string }) | undefined) {
  return Boolean(turn && open(turn.state) && !stoppedByUser(turn) && turn.billing?.cancelRequested !== true);
}

/**
 * Stop one round, remembering it in this tab first so it says 已停止 from the click on. A failed request
 * may still have been recorded (a lost answer), so the record is dropped only when the re-read view
 * proves it was not (stopNotRecorded). Resolves true when the stop request failed.
 */
export async function stopWithRecord(at: { storage: Storage | null; sessionId: string; executionId: string },
  cancel: () => Promise<unknown>, reread: () => Promise<{ isError: boolean; data?: { executions?: unknown } }>) {
  rememberUserStop(at.storage, at.sessionId, at.executionId);
  const failed = await cancel().then(() => false, () => true);
  const view = await reread();
  const turns = view.data?.executions as Array<StopSignals & { executionId: string; state: string }> | undefined;
  if (failed && !view.isError && stopNotRecorded(turns?.find(turn => turn.executionId === at.executionId)))
    forgetUserStop(at.storage, at.sessionId, at.executionId);
  return failed;
}

const open = (state: string) => state !== 'completed' && state !== 'cancelled';
/** Execution states the view shows while a call is about to run or running. */
export const inFlight = (state: string) => state === 'prepared' || state === 'running';

/**
 * Notices shown under one turn, in the conversation. Every still-open turn gets one notice
 * carrying its "重试" (resume the same execution) and "停止" (cancel what remains) actions.
 * A BILL-PAYG pause and a skipped organizer carry their own notices (payg-wait.ts) instead.
 */
export function runtimeTurnNotices(turn: RuntimeTurn, ctx: {
  busy: boolean; capacity: boolean; gateStop?: string; userStopped?: boolean; stopping: boolean;
  /** The execute call for this turn already returned a final state; the view has not caught up yet. */
  finished?: boolean;
  onRetry: () => void; onStop: () => void;
  /** Guide-card navigation; tests replace it. */
  navigate?: (href: string) => void;
}): ChatNotice[] {
  const id = (suffix: string) => turn.executionId + ':' + suffix;
  const notices: ChatNotice[] = [];
  const skipped = organizerSkipped(turn);
  const stopped = stoppedByUser(turn, ctx.userStopped);
  const userStop: ChatNotice = { id: id('stopped'), tone: 'status', text: USER_STOP_NOTICE };
  if (turn.primaryBody && !turn.organizerComplete && !skipped) notices.push({ id: id('organizer'), tone: 'status', text: '主回复已保存，附属整理未完成。' });
  // Both reasons say "not charged"; only a finished (cancelled) round may show them.
  if (turn.unavailableReason === 'provider_history' && turn.state === 'cancelled')
    return [{ id: id('history'), tone: 'warning', text: PROVIDER_HISTORY_NOTICE }];
  // preflight: automatic refund (0215); platform_review: compensated after the daily review (0220).
  if ((turn.unavailableReason === 'preflight' || turn.unavailableReason === 'platform_review') && turn.state === 'cancelled')
    return [{ id: id('platform'), tone: 'warning', text: PLATFORM_FAILURE_NOTICE }];
  // POSITIONING-GATE fallback refusal: refunded through fail_platform (0233).
  if (turn.unavailableReason === 'positioning_required' && turn.state === 'cancelled')
    return [positioningRequiredNotice(id('positioning'), ctx.navigate)];
  if (turn.historyOmitted)
    notices.push({ id: id('history-omitted'), tone: 'status', text: HISTORY_OMITTED_NOTICE });
  // The view names a whole-turn provider refusal; the same text the execute result showed live.
  if (turn.state === 'cancelled' && !skipped)
    notices.push(ctx.gateStop ? { id: id('cancelled'), tone: 'warning', text: ctx.gateStop }
      : turn.unavailableReason === 'provider_rejected' ? { id: id('cancelled'), tone: 'warning', text: PROVIDER_REJECTED_NOTICE }
      : stopped ? userStop : { id: id('cancelled'), tone: 'warning', text: ENDED_NOTICE });
  // A stop that kept the shown text is saved as a completed round; it still says 已停止.
  if (turn.state === 'completed' && stopped) notices.push(userStop);
  if (turn.needsTask)
    notices.push({ id: id('task'), tone: 'warning', text: '当前入口暂不支持这个 Skill 的任务选择。可点“停止”后使用普通对话。' });
  if (turn.unavailableReason === 'output_truncated') notices.push({ id: id('truncated'), tone: 'warning', text: OUTPUT_TRUNCATED_NOTICE });
  if (turn.unavailableReason === 'latest_unavailable')
    notices.push({ id: id('latest'), tone: 'warning', text: '本次未取得搜索资料，无法提供已核实的最新信息。' });
  if (!open(turn.state) || isPaygWaiting(turn.state)) return notices;
  // A stopped round still being saved is not unfinished: no 回复尚未完成, no 重试 or 停止. Only a
  // cost still being verified keeps its own notice below. An `interrupted` round left by a lost save
  // offers 重试, which only finishes the saved stop (never a new call).
  if (stopped && turn.state !== 'cost_pending') {
    const finish = { label: CHAT_ACTION.retry, onClick: ctx.onRetry, disabled: ctx.busy };
    notices.push(turn.state === 'interrupted' && !ctx.busy ? { ...userStop, actions: [finish] } : userStop);
    return notices;
  }
  const capacity = ctx.capacity;
  const stop = { label: CHAT_ACTION.stop, onClick: ctx.onStop, disabled: ctx.stopping };
  // A finished call matters only while the view still shows the turn in flight; any other re-read
  // state (interrupted, cost_pending, …) keeps its own notice and retry.
  const settling = Boolean(ctx.finished) && inFlight(turn.state);
  const retry = { label: CHAT_ACTION.retry, onClick: ctx.onRetry, disabled: ctx.busy || settling };
  const running = (ctx.busy || settling) && !capacity && turn.state !== 'cost_pending';
  notices.push({
    id: id('open'),
    tone: running ? 'status' : 'warning',
    busy: running,
    text: capacity ? CAPACITY_NOTICE : turn.state === 'cost_pending' ? '费用待核实；重试只核对原调用。'
      : running ? '正在回复…' : '回复尚未完成，原请求已保留。',
    actions: capacity ? [stop] : [retry, stop],
  });
  return notices;
}

/**
 * Notices after the last turn. The guidance retry is keyed on the held request (state), never
 * on the wording of the last error; an error already shown under the last turn is not repeated.
 */
export function runtimeTailNotices(ctx: {
  error: string; heldGuide: boolean; busy: boolean; onGuide: () => void;
  lastTurn?: { open: boolean; texts: readonly string[] };
  navigate?: (href: string) => void;
}): ChatNotice[] {
  const notices: ChatNotice[] = [];
  if (ctx.heldGuide)
    notices.push({ id: 'guide', tone: 'warning', text: GUIDE_HELD_NOTICE, label: '引导待重试',
      actions: [{ label: CHAT_ACTION.retry, onClick: ctx.onGuide, disabled: ctx.busy }] });
  const repeated = ctx.lastTurn?.texts.includes(ctx.error) || (ctx.heldGuide && ctx.error === GUIDE_HELD_NOTICE);
  // POSITIONING-GATE: the refusal (admission or a refunded round) shows the guide card, once.
  if (ctx.error === POSITIONING_REQUIRED_NOTICE) { if (!repeated) notices.push(positioningRequiredNotice('positioning', ctx.navigate)); }
  else if (ctx.error && !repeated) notices.push({ id: 'error', tone: 'error', text: ctx.error });
  if (ctx.busy && !ctx.lastTurn?.open) notices.push({ id: 'busy', tone: 'status', busy: true, text: '正在处理，请稍候…' });
  return notices;
}

export function isOpenTurn(state: string) {
  return open(state);
}
