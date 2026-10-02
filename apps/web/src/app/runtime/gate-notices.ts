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
