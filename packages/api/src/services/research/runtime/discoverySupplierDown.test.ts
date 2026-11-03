/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Round 13 (staging): TikHub answered HTTP 402 to every call. A benchmark discovery the supplier could not serve says so (not "not enough
// candidates"), also when the round is continued and every operation is replayed from what was saved. No test reaches a supplier.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../vendors/config';
import { tikhubRouteId } from '../vendors/tikhub';
import { discover } from './discovery';
import type { DiscoveryRecord, RuntimeOperation, RuntimeResearchStore } from './store';
import { requestIdentity, runSubcall, type SubcallContext } from './subcall';
import type { ResearchToolContext } from './toolContext';

vi.mock('./subcall', async importOriginal => ({ ...await importOriginal<typeof import('./subcall')>(), runSubcall: vi.fn() }));
const subcall = vi.mocked(runSubcall);
const id = '11111111-1111-4111-8111-111111111111';
const discoveryId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-11-03T08:00:00Z');

function fixture(reason: string, httpStatus: number, posts?: string[]) {
  const operations = new Map<string, RuntimeOperation>();
  const discoveries = new Map<string, DiscoveryRecord>();
  const evidence = { open: vi.fn(), dispatch: vi.fn(), finish: vi.fn(), link: vi.fn(), cancel: vi.fn() };
  const store = {
    authorization: { keywordConfirmation: vi.fn().mockResolvedValue({ keywords: ['社区咖啡店', '写字楼咖啡', '午休咖啡'] }),
      candidateConfirmation: vi.fn(), userMessage: vi.fn(), refreshGrant: vi.fn() },
    evidence: vi.fn(() => evidence),
    readOperation: vi.fn(async (key: string) => operations.get(key) ?? null),
    readPlan: vi.fn().mockResolvedValue(null), readCard: vi.fn().mockResolvedValue(null), cancelUnsentPlan: vi.fn(),
    createCard: vi.fn(),
    discoveryStart: vi.fn(async (_c: string, platforms: string[]) => {
      const record = { discoveryId, keywords: ['社区咖啡店', '写字楼咖啡', '午休咖啡'], platforms, cursor: {}, state: 'running' };
      discoveries.set(discoveryId, record as DiscoveryRecord);
      return record;
    }),
    discoveryRead: vi.fn(async (key: string) => discoveries.get(key) ?? null),
    discoverySave: vi.fn(async (key: string, cursor: Record<string, unknown>, state: 'running' | 'completed') => {
      const record = { ...discoveries.get(key)!, cursor, state };
      discoveries.set(key, record);
      return record;
    }),
    selectedAccounts: vi.fn().mockResolvedValue([]), offerShortfall: vi.fn().mockResolvedValue(null), callCharge: vi.fn().mockResolvedValue('0'),
  } as unknown as RuntimeResearchStore;
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  const config = researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: ['xiaohongshu'], benchmarkPlatforms: ['xiaohongshu'], limits: { maxSubcallsPerRound: 25, discoverSubcalls: 25 },
    routes: (['keyword_posts', 'account_posts', 'account_profile'] as const).map(kind => ({ platform: 'xiaohongshu', kind, vendor: 'tikhub',
      route: tikhubRouteId('xiaohongshu', kind), backup: null, maxUnitsPerCall: '1' })) });
  subcall.mockImplementation(async (context, request) => {
    const operationId = context.newId();
    if (request.vendor !== 'tikhub') throw new Error('unexpected vendor');
    // `posts`: the keyword searches work and return these authors' posts; only the other lookups are refused.
    if (posts && request.call.kind === 'keyword_posts') {
      const items = posts.map((author, n) => ({ fields: { id: `${author}-v${n}`, authorId: author, author: `Name ${author}`, title: 'video',
        publishedAt: now.toISOString(), views: 1000, likes: 10, comments: 1, shares: 1 }, missing: [] as string[] }));
      operations.set(operationId, { state: 'succeeded', identityHash: requestIdentity(request),
        result: { items, outcome: 'ok', reason: null, fetchedAt: now.toISOString(), truncated: false } });
      return { sent: true, operationId, callId: id, result: { vendor: 'tikhub', route: request.route, outcome: 'ok', reason: null,
        httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items, truncated: false, fetchedAt: now.toISOString() } };
    }
    operations.set(operationId, { state: 'failed', identityHash: requestIdentity(request),
      result: { items: [], outcome: 'failed', reason, fetchedAt: now.toISOString(), truncated: false } });
    return { sent: true, operationId, callId: id, result: { vendor: 'tikhub', route: request.route, outcome: 'failed', reason,
      httpStatus, supplierMayCharge: false, usage: { unit: 'call', units: '0' }, items: [], truncated: false, fetchedAt: now.toISOString() } };
  });
  const subcallContext = { policies: [], billing: { runId: id, claim: vi.fn(), dispatch: vi.fn(), record: vi.fn() }, evidence,
    nextSequence: vi.fn(), phase: 'question', secrets: vi.fn(), rateCounter: vi.fn(), newId: vi.fn() } as unknown as SubcallContext;
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config, store,
    subcall: subcallContext, emit: vi.fn(), now: () => now };
  return { ctx, store, discoveries };
}
const start = { keywordConfirmationId: id, platforms: ['xiaohongshu'] } as never;

beforeEach(() => { vi.clearAllMocks(); });

describe('a benchmark discovery the supplier could not serve', () => {
  it('says the supplier is unavailable, saves the round with the mark (0492: not a round) and shows no card', async () => {
    const f = fixture('HTTP_402', 402);
    const envelope = JSON.parse(await discover(f.ctx, start, { left: 25, used: 0 }));
    expect(envelope).toMatchObject({ status: 'unavailable', reason: 'SUPPLIER_UNAVAILABLE', candidateCard: { shown: false }, availableCandidates: 0 });
    expect(envelope.nextStep).toContain('不是关键词的问题');
    expect(envelope.nextStep).toContain('不要建议换关键词');
    // Web searches in the same round may have been charged: the coach is never told that nothing was.
    expect(envelope.nextStep).not.toContain('扣用户积分');
    expect(f.store.createCard).not.toHaveBeenCalled();
    expect(f.discoveries.get(discoveryId)).toMatchObject({ state: 'completed', cursor: { supplierDown: true } });
  });

  it('continued with every operation replayed from what was saved: still the outage, not "not enough candidates" (review P2)', async () => {
    const f = fixture('HTTP_402', 402);
    await discover(f.ctx, start, { left: 25, used: 0 });
    const sentBefore = subcall.mock.calls.length;
    expect(sentBefore).toBeGreaterThan(0);
    // The next reply: the discovery is read by id and the saved operations are replayed; nothing is sent again.
    const again = JSON.parse(await discover(f.ctx, { discoveryId } as never, { left: 25, used: 0 }));
    expect(subcall.mock.calls.length).toBe(sentBefore);
    expect(again).toMatchObject({ status: 'unavailable', reason: 'SUPPLIER_UNAVAILABLE' });
    expect(again.reason).not.toBe('NOT_ENOUGH_CANDIDATES');
    expect(f.discoveries.get(discoveryId)?.cursor).toMatchObject({ supplierDown: true });
  });

  it('a normal empty answer is still "not enough candidates", replayed or not', async () => {
    for (const [reason, status] of [['NO_RESULTS', 200], ['HTTP_400', 400], ['HTTP_404', 404]] as const) {
      vi.clearAllMocks();
      const f = fixture(reason, status);
      const first = JSON.parse(await discover(f.ctx, start, { left: 25, used: 0 }));
      expect(first.reason).not.toBe('SUPPLIER_UNAVAILABLE');
      const again = JSON.parse(await discover(f.ctx, { discoveryId } as never, { left: 25, used: 0 }));
      expect(again.reason).not.toBe('SUPPLIER_UNAVAILABLE');
      expect(f.discoveries.get(discoveryId)?.cursor).not.toHaveProperty('supplierDown');
    }
  });

  it('the search returned posts and only the profile lookups were refused: the round got data, so it is no outage round (review P2)', async () => {
    const f = fixture('HTTP_402', 402, ['a0', 'a1', 'a2']);
    const envelope = JSON.parse(await discover(f.ctx, start, { left: 25, used: 0 }));
    expect(envelope.reason).not.toBe('SUPPLIER_UNAVAILABLE');
    expect(envelope.nextStep ?? '').not.toContain('不要建议换关键词，不要说已经搜完');
    expect(f.discoveries.get(discoveryId)?.cursor).not.toHaveProperty('supplierDown');
    const again = JSON.parse(await discover(f.ctx, { discoveryId } as never, { left: 25, used: 0 }));
    expect(again.reason).not.toBe('SUPPLIER_UNAVAILABLE');
    expect(f.discoveries.get(discoveryId)?.cursor).not.toHaveProperty('supplierDown');
  });
});
