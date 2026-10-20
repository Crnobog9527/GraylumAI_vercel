/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { OUTPUT_TRUNCATED_NOTICE, PLATFORM_FAILURE_NOTICE, PROVIDER_HISTORY_NOTICE, gateAdmissionNotice, gateResultNotice,
  isRuntimeGateReason } from '@/lib/runtime-gate-notice';
import { hostNotice } from '@/lib/payg-wait';
import { RUNTIME_INPUT_TOO_LONG_MESSAGE } from '../../../../../../../packages/api/src/shared/runtimeInputMessages';
import { RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE } from '../../../../../../../packages/api/src/shared/runtimeAdmissionMessages';
import { isPositioningRequired, POSITIONING_REQUIRED_REASON } from '../../../../../../../packages/api/src/shared/positioningGate';

export { OUTPUT_TRUNCATED_NOTICE };
/** POSITIONING-GATE step 2 interim text; the guide card (start positioning / import) is step 3. */
export const POSITIONING_REQUIRED_NOTICE =
  '为自己的账号做社媒运营之前，需要先完成账号定位：请到“对话”里开始定位，或导入你已有的定位。本次没有扣积分。';
const videoGatePrefix = 'OPC_CONTENT_GATE_';

const LIBRARY_REFUSAL = /^(LIB_REFERENCE_[A-Z_]+)：(.+)$/s;

/**
 * UI-B: a `runtime.prepare` refusal of the message's library references (LIB-4b). Every one comes before any charge and
 * its message is the stable code, a full-width colon and the user's text; the text is shown, never the code.
 */
export function libraryReferenceRefusal(cause: unknown): { code: string; notice: string } | null {
  const data = cause instanceof Error ? (cause as { data?: { path?: unknown } }).data : undefined;
  if (!(cause instanceof Error) || data?.path !== 'runtime.prepare') return null;
  const match = LIBRARY_REFUSAL.exec(cause.message);
  return match ? { code: match[1], notice: match[2] } : null;
}

/** LIB-4b: a referenced document was deleted while the turn ran; the stream ended and nothing of it may stay shown. */
export function isLibrarySourceDeleted(cause: unknown) {
  return cause instanceof Error && cause.message.startsWith('LIB_SOURCE_DELETED');
}
export const SOURCE_DELETED_NOTICE = '引用的文档已删除，这一轮回答不再显示。';

/** A `runtime.prepare` refusal by the new-work gate; the caller keeps the request and input. */
export function runtimeAdmissionNotice(cause: unknown): string | null {
  const library = libraryReferenceRefusal(cause);
  if (library) return library.notice;
  // Too-long input was refused before admission: the text stays in the box to shorten or split.
  const data = cause instanceof Error ? (cause as { data?: { code?: unknown; path?: unknown } }).data : undefined;
  if (cause instanceof Error && cause.message === RUNTIME_INPUT_TOO_LONG_MESSAGE && data?.code === 'PRECONDITION_FAILED' &&
    data.path === 'runtime.prepare') return RUNTIME_INPUT_TOO_LONG_MESSAGE;
  // The model has no per-call billing profile: refused before any call or charge, so say so instead of "pending".
  if (cause instanceof Error && cause.message === RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE && data?.code === 'PRECONDITION_FAILED' &&
    data.path === 'runtime.prepare') return RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE;
  // Refused before admission (no execution, no charge): show the fixed text, never the code.
  if (cause instanceof Error && data?.code === 'PRECONDITION_FAILED' && data.path === 'runtime.prepare' &&
    isPositioningRequired(cause)) return POSITIONING_REQUIRED_NOTICE;
  return gateAdmissionNotice(cause, ['runtime.prepare']);
}

/** Fixed notice for an execution result; capacity keeps its page-specific handling. */
export function runtimeExecutionNotice(result: unknown): string | null {
  const notice = hostNotice(result);
  if (notice) return notice;
  if (!result || typeof result !== 'object' || !('unavailable' in result)) return null;
  if (result.unavailable === 'provider_history') return PROVIDER_HISTORY_NOTICE;
  if (result.unavailable === 'preflight' || result.unavailable === 'platform_review') return PLATFORM_FAILURE_NOTICE;
  if (result.unavailable === 'output_truncated') return OUTPUT_TRUNCATED_NOTICE;
  if (result.unavailable === POSITIONING_REQUIRED_REASON) return POSITIONING_REQUIRED_NOTICE;
  return gateResultNotice(result.unavailable);
}

/** The package execution was cancelled before its first call: a definite, uncharged refusal. */
export function videoGateError(result: unknown): Error | null {
  if (!result || typeof result !== 'object' || !('unavailable' in result)) return null;
  return isRuntimeGateReason(result.unavailable) ? new Error(videoGatePrefix + result.unavailable) : null;
}

export function videoGateNotice(message: string): string | null {
  return message.startsWith(videoGatePrefix) ? gateResultNotice(message.slice(videoGatePrefix.length)) : null;
}

type GateStopStorage = Pick<Storage, 'getItem' | 'setItem'>;
const gateStopKey = (sessionId: string, executionId: string) => 'opc-runtime-gate:' + sessionId + ':' + executionId;

/**
 * The server keeps a gate stop as a plain cancelled execution; only the execute response
 * names the reason. Remember it in this browser so the stopped round keeps its fixed notice
 * after a refetch or reload. Returns the notice, or null for any other result.
 */
export function rememberGateStop(storage: GateStopStorage | null, sessionId: string, executionId: string, result: unknown) {
  if (!result || typeof result !== 'object' || !('unavailable' in result) || !isRuntimeGateReason(result.unavailable)) return null;
  try { storage?.setItem(gateStopKey(sessionId, executionId), result.unavailable); } catch { /* The current notice still shows. */ }
  return gateResultNotice(result.unavailable);
}

/** Fixed notices of cancelled executions this browser saw stopped by the gate. */
export function gateStopNotices(storage: GateStopStorage | null, sessionId: string,
  executions: ReadonlyArray<{ executionId: string; state: string }>): Record<string, string> {
  const notices: Record<string, string> = {};
  for (const execution of executions) {
    if (execution.state !== 'cancelled') continue;
    let reason: string | null = null;
    try { reason = storage?.getItem(gateStopKey(sessionId, execution.executionId)) ?? null; } catch { /* Unknown after storage loss. */ }
    const notice = gateResultNotice(reason);
    if (notice) notices[execution.executionId] = notice;
  }
  return notices;
}

const userStopKey = (sessionId: string, executionId: string) => 'opc-runtime-user-stop:' + sessionId + ':' + executionId;

/**
 * A plain cancel leaves no "the user asked" flag in the view (only a stop that keeps the shown text
 * records pausedReason user_stop), so this browser remembers the stops its user requested; a cancelled
 * round says 已停止 only then. Call it before the cancel request.
 */
export function rememberUserStop(storage: GateStopStorage | null, sessionId: string, executionId: string) {
  try { storage?.setItem(userStopKey(sessionId, executionId), '1'); } catch { /* The round then shows the neutral ended notice. */ }
}

/**
 * A stop request that failed: the round goes back to its open notice and 重试, unless the view shows the
 * server recorded the stop after all (stoppedByUser reads that too).
 */
export function forgetUserStop(storage: Pick<Storage, 'removeItem'> | null, sessionId: string, executionId: string) {
  try { storage?.removeItem(userStopKey(sessionId, executionId)); } catch { /* Nothing stored to remove. */ }
}

/** Execution ids of rounds whose stop this browser's user requested. */
export function userStopIds(storage: GateStopStorage | null, sessionId: string, executions: ReadonlyArray<{ executionId: string }>) {
  return executions.flatMap(execution => {
    try { return storage?.getItem(userStopKey(sessionId, execution.executionId)) === '1' ? [execution.executionId] : []; }
    catch { return []; }
  });
}

/**
 * A cancelled round with no saved body is finished: there is nothing left to verify or show.
 * A paused round without a saved body shows only its pause notice. A round still in progress shows its streamed
 * text (or nothing yet) with its own "正在回复…" notice, never a "verifying" placeholder (CHAT-NATIVE-OUTPUT).
 */
export function showsReply(execution: { state: string; body: string | null; primaryBody: string | null }) {
  return execution.state === 'completed' || Boolean(execution.body ?? execution.primaryBody);
}

/**
 * A structured tRPC refusal the server definitely did not process further: an HTTP 4xx other than
 * 401 (sign in again), 408 (outcome unknown) and 429 (rate limit; the same request is resent later).
 * Decided by status, never by wording. Any other failure leaves the outcome open.
 */
export function definiteRefusal(cause: unknown): { path: string } | null {
  if (!(cause instanceof Error) || !('data' in cause) || !cause.data || typeof cause.data !== 'object') return null;
  const data = cause.data as { httpStatus?: unknown; path?: unknown };
  const status = Number(data.httpStatus);
  if (!Number.isInteger(status) || status < 400 || status > 499 || [401, 408, 429].includes(status)) return null;
  return { path: String(data.path ?? '') };
}

/** A definite admission refusal: nothing was admitted, so no model call and no charge. */
export const DEFINITE_REFUSAL_NOTICE = '这次请求没有被受理：没有发起模型调用，也没有扣积分。';

/**
 * Fixed text for a definite refusal of one of `paths`, or null when the outcome is open.
 * Only shared fixed texts are shown; any other refusal gets the neutral definite notice.
 */
export function definiteRefusalNotice(cause: unknown, paths: readonly string[]): string | null {
  const refused = definiteRefusal(cause);
  if (!refused || !paths.includes(refused.path)) return null;
  const message = (cause as Error).message;
  if (message === RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE || message === RUNTIME_INPUT_TOO_LONG_MESSAGE) return message;
  return DEFINITE_REFUSAL_NOTICE;
}
