/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isSandboxErrorCode, type SandboxErrorCode } from './errors';

/**
 * Messages between the Graylum page (parent), the sandboxed relay frame and the parser Worker.
 * Every message carries the per-run token; anything with an unexpected shape is ignored or
 * rejected, never interpreted. Parser output is untrusted data until a format validator accepts it.
 */

export const MESSAGE = {
  start: 'graylum-sandbox:start',
  abort: 'graylum-sandbox:abort',
  ready: 'graylum-sandbox:ready',
  result: 'graylum-sandbox:result',
  failure: 'graylum-sandbox:failure',
} as const;

export type FrameMessage =
  | { type: typeof MESSAGE.ready }
  | { type: typeof MESSAGE.result; data: unknown }
  | { type: typeof MESSAGE.failure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A message posted by the relay frame for this run, or null when it must be ignored. */
export function parseFrameMessage(data: unknown, token: string): FrameMessage | null {
  if (!isRecord(data) || data.token !== token) return null;
  if (data.type === MESSAGE.ready) return { type: MESSAGE.ready };
  if (data.type === MESSAGE.failure) return { type: MESSAGE.failure };
  if (data.type === MESSAGE.result && 'data' in data) return { type: MESSAGE.result, data: data.data };
  return null;
}

export type WorkerReply = { ok: true; value: unknown } | { ok: false; code: SandboxErrorCode };

/** The single reply a parser Worker sends: a value, or a stable error code. */
export function parseWorkerReply(data: unknown): WorkerReply | null {
  if (!isRecord(data)) return null;
  if (data.ok === true && 'value' in data) return { ok: true, value: data.value };
  if (data.ok === false && isSandboxErrorCode(data.code)) return { ok: false, code: data.code };
  return null;
}

export { isRecord };
