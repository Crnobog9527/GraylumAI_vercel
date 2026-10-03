/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { runtimeGateMessages } from '../../../../packages/api/src/shared/runtimeGateMessages';

/**
 * Fixed notices for the Runtime new-work gate (RATE-LIMIT). Only these four
 * texts are shown; arbitrary server text never is. A refused request is never
 * retried automatically: the caller keeps its input, request id and recovery
 * record so the same request can be sent again later.
 */
export type RuntimeGateReason = 'call_limited' | 'paused' | 'limit_unavailable';

const gateReasons: readonly string[] = ['call_limited', 'paused', 'limit_unavailable'];

export function isRuntimeGateReason(value: unknown): value is RuntimeGateReason {
  return typeof value === 'string' && gateReasons.includes(value);
}

/** Execution result reason. `call_limited` carries no window, so it always uses the minute text. */
export function gateResultNotice(unavailable: unknown): string | null {
  if (unavailable === 'call_limited') return runtimeGateMessages.minute;
  if (unavailable === 'paused') return runtimeGateMessages.paused;
  if (unavailable === 'limit_unavailable') return runtimeGateMessages.limit_unavailable;
  return null;
}

/**
 * Message-admission refusal. 429 is always a rate refusal (the day text only
 * when the server sent exactly that text); 503 maps only the two whitelisted
 * texts, so other service failures keep their own handling. `paths` limits the
 * match to the admission procedures of the calling page.
 */
export function gateAdmissionNotice(cause: unknown, paths: readonly string[]): string | null {
  if (!(cause instanceof Error) || !('data' in cause) || !cause.data || typeof cause.data !== 'object') return null;
  const data = cause.data as { code?: unknown; path?: unknown };
  if (!paths.includes(String(data.path))) return null;
  if (data.code === 'TOO_MANY_REQUESTS')
    return cause.message === runtimeGateMessages.day ? runtimeGateMessages.day : runtimeGateMessages.minute;
  if (data.code !== 'SERVICE_UNAVAILABLE') return null;
  if (cause.message === runtimeGateMessages.paused) return runtimeGateMessages.paused;
  if (cause.message === runtimeGateMessages.limit_unavailable) return runtimeGateMessages.limit_unavailable;
  return null;
}
