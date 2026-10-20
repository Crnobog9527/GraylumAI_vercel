/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
type Failure = { errorType: 'timeout' | 'network' | 'aborted' | 'permission' | 'invalid_reply' | 'rpc' | 'unknown'; retryable: boolean };
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Inspect only recognized transport signatures. Never return a raw message, code, cause or response to logs. */
export function secretReadFailure(error: unknown, signal: AbortSignal): Failure {
  const item = record(error), cause = record(item.cause);
  const codes = [item.code, cause.code];
  if (['42501', '28000', '28P01'].includes(String(item.code)))
    return { errorType: 'permission', retryable: false };
  if (codes.some(code => TIMEOUT_CODES.has(String(code))) ||
    (item.code === '57014' && item.message === 'canceling statement due to statement timeout'))
    return { errorType: 'timeout', retryable: true };
  if (codes.some(code => NETWORK_CODES.has(String(code)))) return { errorType: 'network', retryable: true };
  // A known RPC/configuration denial wins over a deadline that happened to expire at the same time.
  if (typeof item.code === 'string' && item.code !== '') return { errorType: 'rpc', retryable: false };
  if (signal.aborted || item.name === 'TimeoutError') return { errorType: 'timeout', retryable: true };
  if (item.name === 'AbortError' || String(item.message).startsWith('AbortError:'))
    return { errorType: 'aborted', retryable: false };
  if ((item.name === 'TypeError' && item.message === 'fetch failed') ||
    item.message === 'TypeError: fetch failed' || item.message === 'TypeError: Failed to fetch')
    return { errorType: 'network', retryable: true };
  if (item.message === 'PLATFORM_SECRET_REPLY_INVALID') return { errorType: 'invalid_reply', retryable: false };
  return { errorType: typeof item.code === 'string' ? 'rpc' : 'unknown', retryable: false };
}
