/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Whether a failed request has a known outcome. The server refused it when it answered with an
 * application error code (it then changed nothing). When there is no answer at all — the page was
 * reloaded or left, the network dropped, a gateway timed out — or the server failed unexpectedly,
 * the request may still have been carried out: the outcome is unknown and the caller must not undo
 * what it showed, only retry or wait.
 */
export function outcomeUnknown(error: unknown): boolean {
  const data = (error as { data?: { code?: unknown; httpStatus?: unknown } } | null)?.data;
  if (!data || typeof data.code !== 'string') return true;
  // Bounded application refusals (OPC_*, CONTENT_*) are definite even when a router reports them with
  // a generic code, as the OPC routers do.
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && /^(OPC|CONTENT)_[A-Z_]+$/.test(message)) return false;
  return data.code === 'INTERNAL_SERVER_ERROR' || data.code === 'TIMEOUT' || data.code === 'CLIENT_CLOSED_REQUEST';
}
