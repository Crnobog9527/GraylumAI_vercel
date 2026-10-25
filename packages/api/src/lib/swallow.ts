/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger, type LogCategory, type LogContext } from './logger';

/** A stable error code (`FUSION_DATABASE_UNAVAILABLE`), never free text: a raw message may carry user content or ids. */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : error instanceof Error ? error.name : 'unknown';
}

/** Logs a failure the caller deliberately carries on from. The warning is also forwarded to the log sink (Sentry), so a
 * swallowed failure is never silent. `label` is a fixed snake_case name of the place, e.g. `fusion_compare_settle_failed`. */
export function logSwallowed(label: string, error: unknown, context: LogContext & { category?: LogCategory } = {}) {
  const { category = 'system', ...rest } = context;
  logger.warn(category, label, { ...rest, code: errorCode(error), swallowed: true });
}

/** `promise`, or `fallback` when it rejects, with the failure logged: use instead of a bare catch that returns a fallback. */
export function swallow<T, F>(label: string, promise: PromiseLike<T>, fallback: F,
  context?: LogContext & { category?: LogCategory }): Promise<T | F> {
  return Promise.resolve(promise).then(value => value, (error: unknown) => {
    logSwallowed(label, error, context);
    return fallback;
  });
}
