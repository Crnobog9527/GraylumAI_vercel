/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isUnauthorizedError } from '@/lib/auth-recovery';

/*
 * How a read-only query that shapes what the user sees (the save button, the compare entry, the jury entry) asks again. A query that
 * is told `retry: false` and fails once (a 503 from the web proxy while its rate-limit backend is slow, a dropped connection) leaves
 * its part of the page missing until a reload, with nothing said. These asks a failed read again, twice, with a short wait; the
 * page then says that the read failed and offers a retry (QueryNotice).
 */
export const READ_RETRIES = 2;

/** The HTTP status of a failed tRPC call; undefined when there was no response at all (a network failure). */
function statusOf(error: unknown): number | undefined {
  const status = (error as { data?: { httpStatus?: unknown } } | null)?.data?.httpStatus;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Worth asking again: the server or the network failed for a moment (5xx, no answer). Never a refusal that asking again cannot change
 * (a missing login, a 4xx, a 429, which asking again would only make worse).
 */
export function isTransientReadError(error: unknown): boolean {
  if (isUnauthorizedError(error)) return false;
  const status = statusOf(error);
  return status === undefined || status >= 500;
}

export const readRetry = (failureCount: number, error: unknown): boolean => failureCount < READ_RETRIES && isTransientReadError(error);

/** One second, then two (never more than four). */
export const readRetryDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 4000);

/** The two options of a query that uses this policy. */
export const READ_RETRY = { retry: readRetry, retryDelay: readRetryDelay } as const;
