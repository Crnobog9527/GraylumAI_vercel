/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, gateAdmissionNotice, gateResultNotice, isRuntimeGateReason } from '@/lib/runtime-gate-notice';
import { hostNotice, isPaygWaiting } from '@/lib/payg-wait';

export { OUTPUT_TRUNCATED_NOTICE };
const videoGatePrefix = 'OPC_CONTENT_GATE_';

/** A `runtime.prepare` refusal by the new-work gate; the caller keeps the request and input. */
export function runtimeAdmissionNotice(cause: unknown): string | null {
  return gateAdmissionNotice(cause, ['runtime.prepare']);
}

/** Fixed notice for an execution result; capacity keeps its page-specific handling. */
export function runtimeExecutionNotice(result: unknown): string | null {
  const notice = hostNotice(result);
  if (notice) return notice;
  if (!result || typeof result !== 'object' || !('unavailable' in result)) return null;
  if (result.unavailable === 'provider_history') return PROVIDER_HISTORY_NOTICE;
  if (result.unavailable === 'output_truncated') return OUTPUT_TRUNCATED_NOTICE;
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
 * The server keeps no "the user asked" flag in the view, so this browser remembers the stops its user
 * requested; only those cancelled rounds say 已停止. Call it before the cancel request.
 */
export function rememberUserStop(storage: GateStopStorage | null, sessionId: string, executionId: string) {
  try { storage?.setItem(userStopKey(sessionId, executionId), '1'); } catch { /* The round then shows the neutral ended notice. */ }
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
 * A paused round without a saved body shows only its pause notice.
 */
export function showsReply(execution: { state: string; body: string | null; primaryBody: string | null }) {
  return !((execution.state === 'cancelled' || isPaygWaiting(execution.state)) && !(execution.body ?? execution.primaryBody));
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
