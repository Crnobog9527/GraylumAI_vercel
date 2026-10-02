/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { gateAdmissionNotice, gateResultNotice, isRuntimeGateReason } from '@/lib/runtime-gate-notice';

export const OUTPUT_TRUNCATED_NOTICE = '本次模型调用达到长度上限，未返回该阶段正文。已生成内容和原请求已保留，不会自动重试。';
const videoGatePrefix = 'OPC_CONTENT_GATE_';

/** A `runtime.prepare` refusal by the new-work gate; the caller keeps the request and input. */
export function runtimeAdmissionNotice(cause: unknown): string | null {
  return gateAdmissionNotice(cause, ['runtime.prepare']);
}

/** Fixed notice for an execution result; capacity keeps its page-specific handling. */
export function runtimeExecutionNotice(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('unavailable' in result)) return null;
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

/** A cancelled round with no saved body is finished: there is nothing left to verify or show. */
export function showsReply(execution: { state: string; body: string | null; primaryBody: string | null }) {
  return !(execution.state === 'cancelled' && !(execution.body ?? execution.primaryBody));
}
