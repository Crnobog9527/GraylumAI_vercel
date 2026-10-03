/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { trpc } from '@/trpc/client';
import { isUnauthorizedError } from '@/lib/auth-recovery';

/** Retries after the first failure; a failed summary then waits for the "重试" button. */
export const CREDITS_SUMMARY_MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

export function creditsSummaryRetry(failureCount: number, error: unknown): boolean {
  return !isUnauthorizedError(error) && failureCount < CREDITS_SUMMARY_MAX_RETRIES;
}

/** Exponential backoff: 1 s, 2 s, 4 s … capped at 8 s. */
export function creditsSummaryRetryDelay(failureCount: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** failureCount, MAX_DELAY_MS);
}

/**
 * Several profile cards read the same summary. Without `retryOnMount: false` every card that
 * mounts after a failure starts a new round of requests, so a summary that keeps failing
 * would be requested again and again instead of showing the error.
 */
export function useCreditsSummary(period: 'month' | 'all') {
  return trpc.credits.getCreditsSummary.useQuery({ period }, {
    retry: creditsSummaryRetry,
    retryDelay: creditsSummaryRetryDelay,
    retryOnMount: false,
  });
}
