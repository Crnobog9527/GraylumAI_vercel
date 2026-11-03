/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isUnauthorizedError } from '@/lib/auth-recovery';

/*
 * How a read-only query that shapes what the user sees (the save button, the compare entry, the jury entry) asks again. A query that
 * is told `retry: false` and fails once (a 503 from the web proxy while its rate-limit backend is slow, a dropped connection) leaves
 * its part of the page missing until a reload, with nothing said. This asks a failed read again, twice, with a short wait; the
 * page then says that the read failed and offers a retry (QueryNotice).
 */
export const READ_RETRIES = 2;
/** The longest wait between two asks; a server that asks for a longer one is not asked sooner (see isTransientReadError). */
export const MAX_RETRY_DELAY_MS = 4000;

type FailedCall = {
  data?: { httpStatus?: unknown } | null;
  meta?: { response?: { status?: unknown; headers?: { get?: (name: string) => string | null } } | null } | null;
};

/**
 * The HTTP status of a failed tRPC call. A procedure's own failure carries it in `data.httpStatus`; the web proxy answers with plain
 * JSON (its 429 and its 503 when the rate-limit backend is slow), so the client has no `data` and the status is on the response it
 * keeps in `meta`. Undefined: there was no response at all (a network failure).
 */
function statusOf(error: unknown): number | undefined {
  const call = error as FailedCall | null;
  if (typeof call?.data?.httpStatus === 'number') return call.data.httpStatus;
  const status = call?.meta?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** The wait the server asked for with Retry-After, in milliseconds (only the seconds form; undefined when absent or unreadable). */
function retryAfterMs(error: unknown): number | undefined {
  const raw = (error as FailedCall | null)?.meta?.response?.headers?.get?.('retry-after');
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Worth asking again soon: the server or the network failed for a moment (5xx, no answer). Never a refusal that asking again cannot
 * change (a missing login, a 4xx, a 429, which asking again would only make worse), and never sooner than the server asked: the web
 * proxy's 503 says Retry-After 60, so the page says the read failed and the retry button asks later.
 */
export function isTransientReadError(error: unknown): boolean {
  if (isUnauthorizedError(error)) return false;
  const status = statusOf(error);
  if (status === undefined) return true;
  if (status < 500) return false;
  const asked = retryAfterMs(error);
  return asked === undefined || asked <= MAX_RETRY_DELAY_MS;
}

export const readRetry = (failureCount: number, error: unknown): boolean => failureCount < READ_RETRIES && isTransientReadError(error);

/** One second, then two (never more than four). */
export const readRetryDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);

/** The two options of a query that uses this policy. */
export const READ_RETRY = { retry: readRetry, retryDelay: readRetryDelay } as const;
