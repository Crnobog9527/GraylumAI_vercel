/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCQueryUtils, getQueryKey } from '@trpc/react-query';
import type { AppRouter } from '@repo/api/src/root';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDITS_SUMMARY_MAX_RETRIES, CREDITS_SUMMARY_QUERY_OPTIONS } from '@/components/profile/creditsSummaryQuery';
import { isUnauthorizedError } from '@/lib/auth-recovery';
import type { SessionRefresher } from '@/lib/session-refresh';
import { TRPC_MAX_BATCH_CALLS } from '@/lib/trpcBatchLimit';
import { trpc } from '@/trpc/client';
import { sessionRefreshLink } from '@/trpc/session-refresh-link';
import { PROFILE_PREFETCH_DELAY_MS, startProfilePrefetch } from './use-profile-prefetch';

/*
 * The account page asks for its first tab's four reads when it mounts instead of when the cards mount (use-profile-prefetch.ts).
 * Run here on the app's own request chain (the session link and the batching link, as trpc/provider.tsx builds it) against a
 * stand-in server that records every request, with the cards stood in for by what a card's useQuery is underneath: an observer on
 * the procedure's cache entry, with the card's own options.
 */
const INBOX = 'user.paymentNoticeInbox', FOUNDER = 'founder.me', SUMMARY = 'credits.getCreditsSummary', USAGE = 'user.getUserUsageStats';
const CARD_READS = [INBOX, FOUNDER, SUMMARY, USAGE];
const PAGE_READS = ['user.getUserProfile', 'credits.getBalance'];
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

type Answer = 'ok' | 'error' | 'unauthorized';

/** A tRPC server stand-in: answers each call of a request after `latency`, with its own path as the data, and records the requests. */
function fakeServer() {
  const requests: string[][] = [];
  const answers = new Map<string, Answer>();
  const latency = new Map<string, number>();
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const paths = decodeURIComponent(url.pathname.replace('/api/trpc/', '')).split(',');
    requests.push(paths);
    await new Promise(resolve => setTimeout(resolve, Math.max(...paths.map(path => latency.get(path) ?? 100))));
    const body = paths.map(path => {
      const answer = answers.get(path) ?? 'ok';
      if (answer === 'ok') return { result: { data: path } };
      const data = answer === 'unauthorized' ? { code: 'UNAUTHORIZED', httpStatus: 401, path } : { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path };
      return { error: { message: answer, code: -32603, data } };
    });
    return new Response(JSON.stringify(body), { status: 207, headers: { 'content-type': 'application/json' } });
  };
  /** The requests so far that carried any of these reads, each as its list of calls. */
  const carrying = (paths: string[]) => requests.filter(request => request.some(path => paths.includes(path))).map(request => request.join(','));
  const asked = (path: string) => requests.flat().filter(called => called === path).length;
  return { fetch: fetch as typeof globalThis.fetch, requests, answers, latency, carrying, asked };
}

/** The app's client and cache: trpc/provider.tsx's links (without the unbatched reads, none of which is read here) and query defaults. */
function app(server: ReturnType<typeof fakeServer>) {
  const session = { ensureFresh: async () => undefined, refresh: async () => false } as unknown as SessionRefresher;
  const client = createTRPCClient<AppRouter>({
    links: [sessionRefreshLink(session), httpBatchLink({ url: 'http://localhost/api/trpc', maxItems: TRPC_MAX_BATCH_CALLS, fetch: server.fetch })],
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: (count, error) => !isUnauthorizedError(error) && count < 1 } },
  });
  const utils = createTRPCQueryUtils({ queryClient, client });
  const subscriptions: Array<() => void> = [];
  const read = (options: QueryObserverOptions) => {
    const observer = new QueryObserver(queryClient, options);
    subscriptions.push(observer.subscribe(() => undefined));
    return observer;
  };
  return {
    queryClient, utils,
    /** The page's own first reads, made when it mounts. */
    mountPage: () => [
      read({ queryKey: getQueryKey(trpc.user.getUserProfile, undefined, 'query'), queryFn: () => client.user.getUserProfile.query() }),
      read({ queryKey: getQueryKey(trpc.credits.getBalance, undefined, 'query'), queryFn: () => client.credits.getBalance.query(), staleTime: 30_000 }),
    ],
    /** The first tab's cards, each read with the options its card passes (checked against the cards' files below). */
    mountCards: (): Record<string, QueryObserver> => ({
      [INBOX]: read({ queryKey: getQueryKey(trpc.user.paymentNoticeInbox, undefined, 'query'), queryFn: () => client.user.paymentNoticeInbox.query(), staleTime: 60_000 }),
      [FOUNDER]: read({ queryKey: getQueryKey(trpc.founder.me, undefined, 'query'), queryFn: () => client.founder.me.query(), retry: false, refetchOnWindowFocus: false }),
      [SUMMARY]: read({
        queryKey: getQueryKey(trpc.credits.getCreditsSummary, { period: 'month' }, 'query'),
        queryFn: () => client.credits.getCreditsSummary.query({ period: 'month' }), ...CREDITS_SUMMARY_QUERY_OPTIONS,
      }),
      [USAGE]: read({ queryKey: getQueryKey(trpc.user.getUserUsageStats, undefined, 'query'), queryFn: () => client.user.getUserUsageStats.query() }),
    }),
    unmount: () => { for (const stop of subscriptions.splice(0)) stop(); },
  };
}

const signedInOnProfile = { tab: 'profile', signedIn: true } as const;
const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the account page asks for its first tab\'s reads when it mounts', () => {
  it('sends them as a request of their own, right after the page\'s first reads, and the cards that mount later ask for nothing', async () => {
    const server = fakeServer();
    for (const path of PAGE_READS) server.latency.set(path, 700);
    for (const path of CARD_READS) server.latency.set(path, 800);
    const page = app(server);
    page.mountPage();
    startProfilePrefetch(page.utils, signedInOnProfile);

    await settle(PROFILE_PREFETCH_DELAY_MS + 5);
    // Both requests have left before either is answered: the page's own reads never wait for a card's read.
    expect(server.requests.map(request => request.join(','))).toEqual([PAGE_READS.join(','), CARD_READS.join(',')]);

    await settle(700); // The page's reads are back and it draws: the cards mount while their reads are still on the way.
    const cards = page.mountCards();
    await settle(1000);
    expect(server.requests).toHaveLength(2);
    for (const path of CARD_READS) expect(cards[path]!.getCurrentResult().data, path).toBe(path);
    for (const path of CARD_READS) expect(server.asked(path), path).toBe(1);
    page.unmount();
  });

  it('cards that mount after their reads are back find the answers there and ask for nothing', async () => {
    const server = fakeServer();
    for (const path of PAGE_READS) server.latency.set(path, 900);
    const page = app(server);
    page.mountPage();
    startProfilePrefetch(page.utils, signedInOnProfile);
    await settle(1000);
    const cards = page.mountCards();
    for (const path of CARD_READS) expect(cards[path]!.getCurrentResult().data, path).toBe(path);
    await settle(1000);
    expect(server.carrying(CARD_READS)).toEqual([CARD_READS.join(',')]);
    page.unmount();
  });

  it('asks for nothing when nobody is signed in on this browser, on another tab, or when the page goes away first', async () => {
    const server = fakeServer();
    const page = app(server);
    startProfilePrefetch(page.utils, { tab: 'profile', signedIn: false });
    for (const tab of ['subscription', 'credits', 'security', 'tickets'] as const) startProfilePrefetch(page.utils, { tab, signedIn: true });
    startProfilePrefetch(page.utils, signedInOnProfile)(); // Unmounted before the reads left.
    await settle(1000);
    expect(server.requests).toEqual([]);

    // The cards then read for themselves, as before this existed: one request with their four reads.
    page.mountCards();
    await settle(1000);
    expect(server.requests.map(request => request.join(','))).toEqual([CARD_READS.join(',')]);
    page.unmount();
  });

  it('coming back to the page asks for exactly what the cards would ask for: an answer still fresh for its card is not asked for again', async () => {
    const visit = async (prefetch: boolean) => {
      const server = fakeServer();
      const page = app(server);
      if (prefetch) startProfilePrefetch(page.utils, signedInOnProfile);
      await settle(50);
      page.mountCards();
      await settle(500);
      page.unmount();
      // 45 s later: the reminders stay fresh for a minute, the other three for 30 s.
      await settle(45_000);
      const before = server.requests.length;
      if (prefetch) startProfilePrefetch(page.utils, signedInOnProfile);
      await settle(50);
      page.mountCards();
      await settle(500);
      page.unmount();
      return server.requests.slice(before).map(request => [...request].sort().join(','));
    };
    const again = [FOUNDER, SUMMARY, USAGE].sort().join(',');
    expect(await visit(false)).toEqual([again]);
    expect(await visit(true)).toEqual([again]);
  });

  it('a failing credit summary is tried as often as its card tries it, and the card that mounts afterwards does not start over', async () => {
    const server = fakeServer();
    server.answers.set(SUMMARY, 'error');
    const page = app(server);
    startProfilePrefetch(page.utils, signedInOnProfile);
    await settle(10_000); // Its retries (after 1 s, then 2 s) are over; the other answers are still fresh.
    expect(server.asked(SUMMARY)).toBe(1 + CREDITS_SUMMARY_MAX_RETRIES);
    const cards = page.mountCards();
    await settle(10_000);
    expect(cards[SUMMARY]!.getCurrentResult().isError).toBe(true);
    expect(server.asked(SUMMARY)).toBe(1 + CREDITS_SUMMARY_MAX_RETRIES);
    // The reads that worked are not asked for again either.
    for (const path of [FOUNDER, USAGE]) expect(server.asked(path), path).toBe(1);
    page.unmount();
  });

  it('a card that joins a failing read on the way sees what it would have seen by itself, with no extra attempt', async () => {
    const attempts = async (prefetch: boolean) => {
      const server = fakeServer();
      for (const path of [FOUNDER, USAGE, INBOX]) server.answers.set(path, 'error');
      const page = app(server);
      if (prefetch) startProfilePrefetch(page.utils, signedInOnProfile);
      await settle(PROFILE_PREFETCH_DELAY_MS + 5);
      const cards = page.mountCards();
      await settle(60_000);
      for (const path of [FOUNDER, USAGE, INBOX]) expect(cards[path]!.getCurrentResult().isError, path).toBe(true);
      page.unmount();
      return Object.fromEntries(CARD_READS.map(path => [path, server.asked(path)]));
    };
    // FounderProfileCard does not retry; the other two retry once (the app's default).
    expect(await attempts(false)).toEqual({ [FOUNDER]: 1, [USAGE]: 2, [INBOX]: 2, [SUMMARY]: 1 });
    expect(await attempts(true)).toEqual({ [FOUNDER]: 1, [USAGE]: 2, [INBOX]: 2, [SUMMARY]: 1 });
  });

  it('a read that had already failed when its card mounts is read again by the card, once, by the card\'s own rules', async () => {
    const server = fakeServer();
    server.answers.set(FOUNDER, 'error');
    const page = app(server);
    startProfilePrefetch(page.utils, signedInOnProfile);
    await settle(5000);
    expect(server.asked(FOUNDER)).toBe(1);
    page.mountCards();
    await settle(60_000);
    expect(server.asked(FOUNDER)).toBe(2);
    for (const path of [INBOX, SUMMARY, USAGE]) expect(server.asked(path), path).toBe(1);
    page.unmount();
  });

  it('with a session the server no longer accepts: one request, refused, and never tried again', async () => {
    const server = fakeServer();
    for (const path of CARD_READS) server.answers.set(path, 'unauthorized');
    const page = app(server);
    startProfilePrefetch(page.utils, signedInOnProfile);
    await settle(60_000);
    expect(server.requests.map(request => request.join(','))).toEqual([CARD_READS.join(',')]);
  });
});

describe('the reads asked for are the ones the cards make', () => {
  const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;
  const READ = /\btrpc\.[\w.]+\.use(?:Suspense)?(?:Infinite)?Quer(?:y|ies)\(/g;

  it('the first tab still shows these cards, and the page asks for their reads when it mounts', () => {
    const page = source('../app/(zh-hans)/app/profile/page.tsx');
    const tab = /activeTab === 'profile' && \(([\s\S]*?)\n\s*\)\}/.exec(page)?.[1] ?? '';
    // A card added to or taken off this tab: bring prefetchProfileTab (and the reads checked below) in line with it.
    expect([...tab.matchAll(/<([A-Z]\w+)/g)].map(match => match[1])).toEqual(
      ['UserProfileHeader', 'PaymentNoticeInbox', 'FounderProfileCard', 'CreditsAndSubscriptionCards', 'UsageStatsCard', 'QuickActionsCard']);
    expect(page).toContain('useProfilePrefetch(activeTab);');
  });

  it('each card makes the read that is asked for, with the options it is asked for with, and no other read', () => {
    const inbox = source('../components/profile/PaymentNoticeInbox.tsx');
    expect(inbox).toMatch(/trpc\.user\.paymentNoticeInbox\.useQuery\(\s*undefined,\s*\{\s*staleTime:\s*60_000\s*\}\s*\)/);
    expect(count(inbox, READ)).toBe(1);

    const founder = source('../components/founder/FounderProfileCard.tsx');
    expect(founder).toMatch(/trpc\.founder\.me\.useQuery\(\s*undefined,\s*\{\s*retry:\s*false,\s*refetchOnWindowFocus:\s*false\s*\}\s*\)/);
    expect(count(founder, READ)).toBe(1);

    // UserProfileHeader, CreditsAndSubscriptionCards, UsageStatsCard and QuickActionsCard.
    const cards = source('../components/profile/PersonalInfoCard.tsx');
    expect(cards).toMatch(/trpc\.credits\.getCreditsSummary\.useQuery\(\s*\{\s*period:\s*'month'\s*\},\s*CREDITS_SUMMARY_QUERY_OPTIONS\s*\)/);
    expect(cards).toMatch(/trpc\.user\.getUserUsageStats\.useQuery\(\s*\)/);
    expect(count(cards, READ)).toBe(2);
  });
});
