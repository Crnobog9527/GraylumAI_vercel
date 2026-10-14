/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Codes with which the server refuses a request before changing anything. */
const REFUSAL_CODES = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'PRECONDITION_FAILED', 'TOO_MANY_REQUESTS', 'PAYLOAD_TOO_LARGE', 'UNPROCESSABLE_CONTENT']);

/**
 * Whether a failed request has a known outcome. The server refused it when it answered with a refusal
 * code, or with a bounded application refusal (OPC_* / CONTENT_*) that some routers report under a
 * generic code; it then changed nothing. Everything else is unknown — no answer at all (reload, page
 * left, network drop, gateway timeout), an unexpected server failure, or an "*_UNAVAILABLE" result
 * that can follow a committed change — and the caller must not undo what it showed, only retry or wait.
 */
export function outcomeUnknown(error: unknown): boolean {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : '';
  if (!data || typeof data.code !== 'string' || text.endsWith('_UNAVAILABLE')) return true;
  if (/^(OPC|CONTENT)_[A-Z_]+$/.test(text)) return false;
  return !REFUSAL_CODES.has(data.code);
}
