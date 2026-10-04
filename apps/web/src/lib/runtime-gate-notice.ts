/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { runtimeGateMessages } from '../../../../packages/api/src/shared/runtimeGateMessages';

/**
 * Fixed notices for the Runtime new-work gate (RATE-LIMIT). Only these four
 * texts are shown; arbitrary server text never is. A refused request is never
 * retried automatically: the caller keeps its input, request id and recovery
 * record so the same request can be sent again later.
 */
/** One wording for a turn that hit the output length limit, shown once under that turn. */
export const OUTPUT_TRUNCATED_NOTICE = '本次模型调用达到长度上限，未返回该阶段正文。已生成内容和原请求已保留，不会自动重试。';

export const HISTORY_OMITTED_NOTICE = '较早的部分对话记录无法使用，本轮回复未参考它们';

export const PROVIDER_HISTORY_NOTICE = '这条对话的历史记录格式不兼容，本轮无法继续。请新开一个对话，并重新提供需要参考的内容。';

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
