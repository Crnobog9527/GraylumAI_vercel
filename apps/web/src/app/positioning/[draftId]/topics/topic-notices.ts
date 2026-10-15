/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CHAT_ACTION, type ChatNotice } from '@/components/chat/ChatInlineNotice';
import { PROVIDER_REJECTED_NOTICE, gateAdmissionNotice, gateResultNotice } from '@/lib/runtime-gate-notice';
import { USER_STOP_NOTICE, inFlight, stoppedByUser, type StopSignals } from '@/app/runtime/runtime-notices';
import { definiteRefusal, definiteRefusalNotice } from '@/app/runtime/gate-notices';
import { hostNotice, isOrganizerPendingError, isPaygWaiting } from '@/lib/payg-wait';

/** This tab's sessionStorage, where the page remembers the stops its user asked for (display only). */
export function tabSession() {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/** Fixed wording for a failed topic operation; the pending operation itself is kept by the caller. */
export function topicFailureMessage(cause: unknown) {
  const gate = gateAdmissionNotice(cause, ['opc.topicTurn']);
  if (gate) return gate;
  const message = cause instanceof Error ? cause.message : '';
  if (message.includes('OPC_TOPIC_SKILL_MISSING'))
    return '当前定位方法没有声明可用的选题方法资源，无法开始选题工作对话。请联系管理员配置选题 Skill 后再继续；本次没有任何调用或花费。';
  if (message.includes('OPC_TOPIC_SOURCE_REVOKED'))
    return '这个工作空间绑定的定位版本已不可用，暂不能继续派发。原对话和成果仍然保留。';
  if (message.includes('OPC_TOPIC_BOUND') || message.includes('OPC_TOPIC_SOURCE_CHANGED'))
    return '这个草稿已经有绑定的选题工作空间，不能静默换到另一个版本。请继续使用原有工作空间。';
  if (message.includes('OPC_REQUEST_CONFLICT'))
    return '这条消息的原请求身份与现在的负载不一致，已停止发送。请读取原任务状态后再决定。';
  const refused = definiteRefusalNotice(cause, ['opc.topicTurn']);
  if (refused) return refused;
  return '本次请求状态待核实。请点「重试」读取原任务，不要重复发送相同内容。';
}

/**
 * A topic turn the server definitely refused before admitting it (an HTTP 4xx such as a missing billing
 * profile): nothing exists to recover, so the caller releases it instead of holding it as unknown.
 * A request-identity conflict and a pending earlier organizer keep their own handling.
 */
export function topicTurnRefused(cause: unknown) {
  return definiteRefusal(cause)?.path === 'opc.topicTurn' && !(cause as Error).message.includes('OPC_REQUEST_CONFLICT')
    && !isOrganizerPendingError(cause); // waits for the earlier organizer (payg-wait), never a release
}

/**
 * Notice for an admitted topic turn the gate stopped before its first call.
 * The execution is cancelled with no charge, so the operation is finished,
 * but the typed input stays in the box for an explicit new send.
 */
export function topicGateNotice(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('unavailable' in result)) return null;
  return gateResultNotice(result.unavailable);
}

/** What a finished topic turn shows: the host's notice first (#698), else the gate's. Display only. */
export function topicExecutionNotice(result: unknown): string | null {
  return hostNotice(result) ?? topicGateNotice(result);
}

/** A finished topic turn: its notice, and whether the typed input stays (only after a gate stop; a notice is display only). */
export function topicTurnOutcome(result: unknown) {
  return { notice: topicExecutionNotice(result), keepInput: Boolean(topicGateNotice(result)) };
}

/** A cancelled turn the provider refused before any charge: the live notice, kept after a reload. */
export function topicRejectedTurn(e: { state: string; unavailableReason?: string | null }) {
  return e.state === 'cancelled' && e.unavailableReason === 'provider_rejected';
}

/** Once the view names the refusal, the last turn shows it; the live error is not repeated below it. */
export function topicTurnShows(last: { state: string; unavailableReason?: string | null } | undefined, error: string) {
  return Boolean(last && topicRejectedTurn(last) && error === PROVIDER_REJECTED_NOTICE);
}

/**
 * The notice under a topic turn. An open turn carries its "重试" and "停止"; a provider-refused
 * turn only its fixed notice, like any other finished turn. `finished` is the execution
 * whose execute call already returned a final state (finishedExecution): until the view catches
 * up it still reads as running, never as 回复尚未完成. A BILL-PAYG pause has its own notice (payg-wait.ts).
 * A turn the user stopped (`userStopped` is this tab's record; stoppedByUser also reads the view) says
 * 已停止 from the click on, whether it ends cancelled or completed, and is never 回复尚未完成.
 */
export function topicOpenTurnNotice(e: { executionId: string; state: string; unavailableReason?: string | null } & StopSignals, ctx: {
  busy: boolean; finished: string | null; stopping: boolean; userStopped?: boolean; onRetry: () => void; onStop: () => void;
}): ChatNotice | null {
  if (topicRejectedTurn(e)) return { id: e.executionId, tone: 'warning', text: PROVIDER_REJECTED_NOTICE };
  const stopped = stoppedByUser(e, ctx.userStopped);
  const userStop: ChatNotice = { id: e.executionId, tone: 'status', text: USER_STOP_NOTICE };
  if (e.state === 'completed' || e.state === 'cancelled') return stopped ? userStop : null;
  if (isPaygWaiting(e.state)) return null;
  // Still being saved: no 重试 or 停止; an `interrupted` save offers 重试, which only finishes the stop.
  if (stopped && e.state !== 'cost_pending')
    return e.state === 'interrupted' && !ctx.busy ? { ...userStop, actions: [{ label: CHAT_ACTION.retry, onClick: ctx.onRetry }] } : userStop;
  // A finished call matters only while the view still shows the turn in flight (inFlight).
  const settling = ctx.finished === e.executionId && inFlight(e.state);
  const running = (ctx.busy || settling) && e.state !== 'cost_pending';
  return { id: e.executionId, tone: running ? 'status' : 'warning', busy: running,
    text: e.state === 'cost_pending' ? '费用待核实；重试只核对原调用。'
      : running ? '正在回复…' : '回复尚未完成，原请求已保留。',
    actions: [{ label: CHAT_ACTION.retry, disabled: ctx.busy || settling, onClick: ctx.onRetry },
      { label: CHAT_ACTION.stop, disabled: ctx.stopping, onClick: ctx.onStop }] };
}
