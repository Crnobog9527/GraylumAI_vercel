/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import type { CreateQueryUtils } from '@trpc/react-query/shared';
import type { AppRouter } from '@repo/api/src/root';
import { creditsSummaryRetry, creditsSummaryRetryDelay } from '@/components/profile/creditsSummaryQuery';
import { readSessionUserIdSync } from '@/lib/session-user';
import type { ProfileTab } from '@/lib/profile-tabs';
import { trpc } from '@/trpc/client';

/*
 * The account page (/app/profile) draws nothing until its first reads are back (who the user is, the balance), and only then mount
 * the cards of its first tab, which start four reads of their own. Measured on staging (2026-11-11): the first reads leave at
 * 3.09 s, the cards' reads at 3.88 s, so the cards fill in about 0.8 s later than they could.
 *
 * This asks for the cards' four reads when the page mounts. They are the very reads the cards make (same procedure, same input,
 * so the same cache entry): a card that mounts while its read is on the way waits for that one answer, and a card that mounts after
 * it finds the answer already there. Neither asks again.
 *
 * Each read is asked for with its card's own rules, so nothing else changes:
 * - how long an answer counts as fresh, so coming back to the page asks for exactly what the cards would ask for;
 * - how often a failed read is tried again, so a card that joins a read on the way sees what it would have seen by itself.
 *
 * Not asked for: when nobody is signed in on this browser, and when the page opens on another tab (its cards are not on screen).
 */

/** The tab whose cards make these reads. */
export const PROFILE_PREFETCH_TAB: ProfileTab = 'profile';

/**
 * How long after the page mounts the reads leave. tRPC sends the calls made within one turn of the event loop as one request, which
 * is answered when its slowest call is. The page's own first reads leave at once; these leave a moment later, as a request of
 * their own, so the page never waits for a card's read (the month's credit summary, for one) before it draws.
 */
export const PROFILE_PREFETCH_DELAY_MS = 20;

type Utils = Pick<CreateQueryUtils<AppRouter>, 'user' | 'founder' | 'credits'>;

/** The first tab's reads, each as its card makes it: components/profile and components/founder (the test reads those files). */
export function prefetchProfileTab(utils: Utils): Promise<void[]> {
  return Promise.all([
    // PaymentNoticeInbox: an answer is fresh for a minute.
    utils.user.paymentNoticeInbox.prefetch(undefined, { staleTime: 60_000 }),
    // FounderProfileCard: a failed read is not tried again.
    utils.founder.me.prefetch(undefined, { retry: false }),
    // CreditsAndSubscriptionCards: CREDITS_SUMMARY_QUERY_OPTIONS.
    utils.credits.getCreditsSummary.prefetch({ period: 'month' }, { retry: creditsSummaryRetry, retryDelay: creditsSummaryRetryDelay }),
    // UsageStatsCard: the app's defaults.
    utils.user.getUserUsageStats.prefetch(),
  ]);
}

/** Schedules the reads; the returned function calls them off if they have not left yet (the page went away). */
export function startProfilePrefetch(utils: Utils, page: { tab: ProfileTab; signedIn: boolean }): () => void {
  if (!page.signedIn || page.tab !== PROFILE_PREFETCH_TAB) return () => undefined;
  // A read that fails is the card's to show: it reads the same cache entry when it mounts.
  const timer = setTimeout(() => void prefetchProfileTab(utils).catch(() => undefined), PROFILE_PREFETCH_DELAY_MS);
  return () => clearTimeout(timer);
}

/** Once, when the account page mounts, for the tab it opens on. Changing tabs later asks for nothing here. */
export function useProfilePrefetch(tab: ProfileTab): void {
  const utils = trpc.useUtils();
  const openedOn = useRef(tab);
  useEffect(() => startProfilePrefetch(utils, { tab: openedOn.current, signedIn: readSessionUserIdSync() !== null }), [utils]);
}
