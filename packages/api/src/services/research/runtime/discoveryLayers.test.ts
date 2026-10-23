/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-1b: deeper discovery layers (account search, next keyword pages), the per-platform ceiling and
// the coverage report. Supplier answers are synthetic items in the normalized shape; no test reaches a supplier.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../vendors/config';
import { tikhubRouteId } from '../vendors/tikhub';
import type { ResearchItem, SocialKind, SocialPlatform } from '../vendors/types';
import { discover } from './discovery';
import { discoveryCap } from './discoveryLayers';
import type { DiscoveryRecord, RuntimeOperation, RuntimeResearchStore } from './store';
import { requestIdentity, runSubcall, type SubcallContext, type SupplierRequest } from './subcall';
import type { ResearchToolContext } from './toolContext';

vi.mock('./subcall', async importOriginal => ({ ...await importOriginal<typeof import('./subcall')>(), runSubcall: vi.fn() }));
const subcall = vi.mocked(runSubcall);
const id = '11111111-1111-4111-8111-111111111111';
const discoveryId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-20T00:00:00Z');
const KEYWORDS = ['one', 'two', 'three'];

interface Script {
  /** Authors on each keyword's first page. */
  firstPage: (keyword: string) => string[];
  /** Further pages: authors by keyword and cursor; none = no next page. */
  nextPage?: (keyword: string, cursor: string) => { authors: string[]; next?: string } | undefined;
  firstCursor?: string;
  leads?: (keyword: string) => string[];
  followers?: number;
  /** Web search results (Parallel); configured only when given. */
  web?: (query: string) => ResearchItem[];
}

function fixture(platform: SocialPlatform, script: Script, kinds: SocialKind[] = ['keyword_posts', 'account_profile', 'account_posts']) {
  const operations = new Map<string, RuntimeOperation>();
  const discoveries = new Map<string, DiscoveryRecord>();
  const evidence = { open: vi.fn(), dispatch: vi.fn(), finish: vi.fn(), link: vi.fn(), cancel: vi.fn() };
  const store = {
    authorization: { keywordConfirmation: vi.fn().mockResolvedValue({ keywords: KEYWORDS }),
      candidateConfirmation: vi.fn(), userMessage: vi.fn(), refreshGrant: vi.fn() },
    evidence: vi.fn(() => evidence),
    readOperation: vi.fn(async (key: string) => operations.get(key) ?? null),
    readPlan: vi.fn().mockResolvedValue(null), readCard: vi.fn().mockResolvedValue(null), cancelUnsentPlan: vi.fn(),
    createCard: vi.fn(async (cardId: string, payload: { kind: string; options: unknown[] }) =>
      ({ cardId, kind: payload.kind, options: payload.options, minSelect: 3, maxSelect: 5 })),
    discoveryStart: vi.fn(async (_c: string, platforms: string[]) => {
      const record = { discoveryId, keywords: KEYWORDS, platforms, cursor: {}, state: 'running' } as DiscoveryRecord;
      discoveries.set(discoveryId, record);
      return record;
    }),
    discoveryRead: vi.fn(async (key: string) => discoveries.get(key) ?? null),
    discoverySave: vi.fn(async (key: string, cursor: Record<string, unknown>, state: 'running' | 'completed') => {
      const record = { ...discoveries.get(key)!, cursor, state };
      discoveries.set(key, record);
      return record;
    }),
    selectedAccounts: vi.fn().mockResolvedValue([]), offerShortfall: vi.fn().mockResolvedValue(null),
    callCharge: vi.fn().mockResolvedValue('0.6'),
  } as unknown as RuntimeResearchStore;
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  const config = researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: [platform], benchmarkPlatforms: [platform], limits: { maxSubcallsPerRound: 29, discoverSubcalls: 29 },
    routes: [...kinds.map(kind => ({ platform, kind, vendor: 'tikhub', route: tikhubRouteId(platform, kind), backup: null, maxUnitsPerCall: '1' })),
      ...(script.web ? [{ platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null,
        maxUnitsPerCall: '1' }] : [])] });
  const sent: SupplierRequest[] = [];
  const post = (author: string, n: number): ResearchItem => ({ fields: { id: `${author}-v${n}`, ...(author ? { authorId: author } : {}), author: `Name ${author}`,
    title: 'video', publishedAt: now.toISOString(), views: 1000, likes: 10, comments: 1, shares: 1 }, missing: [] });
  subcall.mockImplementation(async (context, request) => {
    const operationId = context.newId();
    sent.push(request);
    let items: ResearchItem[] = [];
    if (request.vendor === 'parallel') {
      items = script.web?.(request.query) ?? [];
      operations.set(operationId, { state: 'succeeded', identityHash: requestIdentity(request),
        result: { items, outcome: 'ok', reason: null, fetchedAt: now.toISOString(), truncated: false } });
      return { sent: true, operationId, callId: id, result: { vendor: 'parallel', route: request.route, outcome: 'ok', reason: null,
        httpStatus: 200, supplierMayCharge: true, usage: { unit: 'sku_search', units: '1' }, items, truncated: false, fetchedAt: now.toISOString() } };
    }
    if (request.vendor !== 'tikhub') throw new Error('vendor');
    const { kind, keyword, cursor, account } = request.call;
    let nextCursor: string | undefined;
    if (kind === 'keyword_posts' && !cursor) {
      items = script.firstPage(keyword!).map((author, n) => post(author, n));
      nextCursor = script.firstCursor;
    } else if (kind === 'keyword_posts') {
      const page = script.nextPage?.(keyword!, cursor!);
      items = (page?.authors ?? []).map((author, n) => post(author, n + 100));
      nextCursor = page?.next;
    } else if (kind === 'account_search') {
      items = (script.leads?.(keyword!) ?? []).map(lead => ({ fields: { id: lead, name: `Lead ${lead}`, followers: 50000 }, missing: [] }));
    } else if (kind === 'account_profile') {
      items = [{ fields: { id: account!, name: `Profile ${account}`, followers: script.followers ?? 50000 }, missing: [] }];
    }
    const result = { items, outcome: 'ok', reason: null, fetchedAt: now.toISOString(), truncated: false, ...(nextCursor ? { nextCursor } : {}) };
    operations.set(operationId, { state: 'succeeded', identityHash: requestIdentity(request), result });
    return { sent: true, operationId, callId: id, result: { vendor: 'tikhub', route: request.route, outcome: 'ok', reason: null,
      httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items, truncated: false, fetchedAt: now.toISOString(),
      ...(nextCursor ? { nextCursor } : {}) } };
  });
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config, store,
    subcall: { policies: [], billing: { runId: id, claim: vi.fn(), dispatch: vi.fn(), record: vi.fn() }, evidence, nextSequence: vi.fn(),
      phase: 'question', secrets: vi.fn(), rateCounter: vi.fn(), newId: vi.fn() } as unknown as SubcallContext,
    emit: vi.fn(), now: () => now };
  const run = async (left = 29, args: Record<string, unknown> = { keywordConfirmationId: id, platforms: [platform] }) =>
    JSON.parse(await discover(ctx, args as never, { left, used: 0 }));
  const kindsSent = () => sent.map(request => request.vendor === 'tikhub' ? request.call.kind : request.vendor);
  return { ctx, store, sent, run, kindsSent, discoveries };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('deeper discovery layers', () => {
  it('first page enough: nothing deeper is searched (cost as before)', async () => {
    const f = fixture('tiktok', { firstPage: keyword => Array.from({ length: 4 }, (_, i) => `${keyword}a${i}`), firstCursor: '20',
      leads: () => ['lead1'] }, ['keyword_posts', 'account_profile', 'account_posts', 'account_search']);
    const envelope = await f.run();
    expect(f.kindsSent()).toEqual([...Array(3).fill('keyword_posts'), ...Array(12).fill('account_profile')]);
    expect(envelope.candidateCard).toMatchObject({ shown: true });
  });

  it('too few first-page authors: searches for accounts with each keyword and screens the leads until the card is full', async () => {
    const f = fixture('tiktok', { firstPage: keyword => [`${keyword}a`], leads: keyword => [`${keyword}l1`, `${keyword}l2`, `${keyword}l3`] },
      ['keyword_posts', 'account_profile', 'account_posts', 'account_search']);
    const envelope = await f.run();
    const profiles = Array(3).fill('account_profile');
    expect(f.kindsSent()).toEqual([...Array(3).fill('keyword_posts'), ...profiles, 'account_search', ...profiles,
      'account_search', ...profiles, 'account_search', ...profiles]);
    expect(envelope.candidateCard).toMatchObject({ shown: true, selectable: 12 });
    expect(envelope.coverage.platforms.tiktok.spent).toEqual({ searches: 3, pages: 0, accountSearches: 3, webSearches: 0, profiles: 12 });
  });

  it('counts only lookups that really ran, and never lets posts without an author count as new authors', async () => {
    // Two real new authors plus two unattributed posts: not three new authors, so no next page is paid for.
    const f = fixture('tiktok', { firstPage: keyword => keyword === 'one' ? ['p1', 'p2', '', ''] : [], firstCursor: '20',
      nextPage: () => ({ authors: ['n1', 'n2', 'n3'] }) });
    const envelope = await f.run();
    expect(f.sent.some(r => r.vendor === 'tikhub' && r.call.cursor)).toBe(false);
    expect(envelope.coverage.platforms.tiktok.spent).toEqual({ searches: 3, pages: 0, accountSearches: 0, webSearches: 0, profiles: 2 });
    // A reply that runs out after two lookups reports those two, not the one it could not send.
    const g = fixture('tiktok', { firstPage: keyword => [`${keyword}a`] });
    const stopped = await g.run(2);
    expect(stopped).toMatchObject({ continue: true, reason: 'ROUND_LIMIT' });
    expect(stopped.coverage.platforms.tiktok.spent).toEqual({ searches: 2, pages: 0, accountSearches: 0, webSearches: 0, profiles: 0 });
  });

  it('pages a keyword only while its last page brought at least three new authors, at most to page 3', async () => {
    const f = fixture('tiktok', { firstPage: keyword => keyword === 'one' ? ['p1', 'p2', 'p3'] : [], firstCursor: '20',
      nextPage: (keyword, cursor) => cursor === '20' ? { authors: ['n1', 'n2'], next: '40' } : { authors: ['m1', 'm2', 'm3'] } });
    const envelope = await f.run();
    // Only "one" brought 3 new authors on page 1; its page 2 brought 2 new ones, so there is no page 3.
    expect(f.sent.filter(r => r.vendor === 'tikhub' && r.call.cursor).map(r => r.vendor === 'tikhub' && [r.call.keyword, r.call.cursor]))
      .toEqual([['one', '20']]);
    expect(envelope.coverage.platforms.tiktok).toMatchObject({ spent: { searches: 3, pages: 1, accountSearches: 0, webSearches: 0, profiles: 5 },
      capReached: false, exhausted: true });
    expect(envelope).toMatchObject({ status: 'partial', reason: 'NOT_ENOUGH_CANDIDATES', candidateCard: { shown: false } });
  });

  it('a 0.01 USD platform stops at its own ceiling, also across replies, and the round still ends', async () => {
    expect([discoveryCap('tiktok', 1), discoveryCap('douyin', 1), discoveryCap('tiktok', 2), discoveryCap('xiaohongshu', 2)])
      .toEqual([80, 40, 40, 20]);
    // Leads with fewer than 10k followers are never selectable, so the scan runs into the ceiling.
    const f = fixture('douyin', { firstPage: () => [], leads: keyword => Array.from({ length: 30 }, (_, i) => `MS4wLjABAAAA${keyword}${'x'.repeat(30)}${i}`),
      followers: 500 },
      ['keyword_posts', 'account_profile', 'account_posts', 'account_search']);
    const first = await f.run(29);
    expect(first).toMatchObject({ continue: true, reason: 'ROUND_LIMIT' });
    const firstSent = f.sent.length;
    const second = await f.run(29, { discoveryId });
    expect(f.sent.length - firstSent).toBe(40 - firstSent);
    expect(second.coverage.platforms.douyin).toMatchObject({ capReached: true });
    expect(second.continue).toBe(false);
    expect(f.discoveries.get(discoveryId)?.state).toBe('completed');
  });

  it('last, reads web pages listing the niche\'s creators and screens the accounts their links name (code-extracted)', async () => {
    const queries: string[] = [];
    const page = (handles: string[]): ResearchItem => ({ url: 'https://example.com/best-creators', missing: [],
      fields: { title: 'Top hardanger creators', excerpt: handles.map(h => `https://www.tiktok.com/@${h}/video/7${h.length}0000000`).join(' ')
        + ' and https://www.youtube.com/@ignored and https://www.tiktok.com/@Shared' } });
    const f = fixture('tiktok', { firstPage: () => [], web: query => { queries.push(query); return [page(['webone', 'webtwo'])]; } });
    const envelope = await f.run();
    expect(queries).toEqual(['one TikTok creators', 'two TikTok creators']);
    const screened = f.sent.filter(r => r.vendor === 'tikhub' && r.call.kind === 'account_profile')
      .map(r => r.vendor === 'tikhub' && r.call.account);
    // Each account once, handles lower-cased as pasted links are; the YouTube @handle link is skipped.
    expect(screened).toEqual(['webone', 'webtwo', 'shared']);
    expect(envelope.coverage.platforms.tiktok).toMatchObject({ spent: { webSearches: 2, profiles: 3 }, exhausted: true });
  });

  it('does not pay for web searches when a card of 8–11 can already show', async () => {
    const web = vi.fn(() => [] as ResearchItem[]);
    const f = fixture('tiktok', { firstPage: keyword => keyword === 'one' ? Array.from({ length: 9 }, (_, i) => `a${i}`) : [], web });
    const envelope = await f.run();
    expect(web).not.toHaveBeenCalled();
    expect(envelope.candidateCard).toMatchObject({ shown: true, selectable: 9 });
  });
});
