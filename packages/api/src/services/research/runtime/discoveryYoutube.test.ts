/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE: YouTube discovery, keyword search → channel authors → one video detail per author → candidate card.
// YouTube has no profile route; before this fix every author was skipped and the round ended with 0 accounts (#1290
// Codex run, 2026-10-23). Supplier answers are the recorded real response shapes (vendors/__tests__/fixtures), parsed by
// the real TikHub normalizer; no test reaches a supplier.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import samples from '../vendors/__tests__/fixtures/youtubeSamples.json';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../vendors/config';
import { tikhubRouteId } from '../vendors/tikhub';
import { normalizeTikhub } from '../vendors/tikhubShapes';
import type { ResearchItem } from '../vendors/types';
import { discover } from './discovery';
import type { DiscoveryRecord, RuntimeOperation, RuntimeResearchStore } from './store';
import { requestIdentity, runSubcall, type SubcallContext, type SupplierRequest } from './subcall';
import type { ResearchToolContext } from './toolContext';

vi.mock('./subcall', async importOriginal => ({ ...await importOriginal<typeof import('./subcall')>(), runSubcall: vi.fn() }));
const subcall = vi.mocked(runSubcall);
const id = '11111111-1111-4111-8111-111111111111';
const discoveryId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-20T00:00:00Z');
const channel = (i: number) => `UC${String(i).padStart(22, 'x')}`;
const CHANNELS = 9;

/** The real keyword search shape with one video per channel (the fixture repeats a few channels). */
function keywordAnswer(keyword: string) {
  const template = samples.keywordSearch.data.videos[0]!;
  return { ...samples.keywordSearch, data: { ...samples.keywordSearch.data, keyword,
    videos: Array.from({ length: CHANNELS }, (_, i) => ({ ...template, video_id: `${keyword.slice(0, 3)}vid${String(i).padStart(5, '0')}`,
      channel_id: channel(i), author: `Channel ${i}` })) } };
}

/** The real video detail shape for the requested video; `stranger` answers with another channel's detail. */
function detailAnswer(videoId: string, stranger: boolean) {
  const index = Number(videoId.slice(-5));
  return { ...samples.videoInfo, data: { ...samples.videoInfo.data, video_id: videoId,
    channel_id: stranger ? channel(99) : channel(index) } };
}

function fixture(strangerFor?: number) {
  const operations = new Map<string, RuntimeOperation>();
  const discoveries = new Map<string, DiscoveryRecord>();
  const evidence = { open: vi.fn(), dispatch: vi.fn(), finish: vi.fn(), link: vi.fn(), cancel: vi.fn() };
  const store = {
    authorization: { keywordConfirmation: vi.fn().mockResolvedValue({ keywords: ['hardanger', 'whitework', 'drawn thread'] }),
      candidateConfirmation: vi.fn(), userMessage: vi.fn(), refreshGrant: vi.fn() },
    evidence: vi.fn(() => evidence),
    readOperation: vi.fn(async (key: string) => operations.get(key) ?? null),
    readPlan: vi.fn().mockResolvedValue(null), readCard: vi.fn().mockResolvedValue(null), cancelUnsentPlan: vi.fn(),
    createCard: vi.fn(async (cardId: string, payload: { kind: string; options: unknown[] }) =>
      ({ cardId, kind: payload.kind, options: payload.options, minSelect: 3, maxSelect: 5 })),
    discoveryStart: vi.fn(async (_c: string, platforms: string[]) => {
      const record = { discoveryId, keywords: ['hardanger', 'whitework', 'drawn thread'], platforms, cursor: {}, state: 'running' };
      discoveries.set(discoveryId, record as DiscoveryRecord);
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
    verifiedPlatforms: ['youtube'], benchmarkPlatforms: ['youtube'], limits: { maxSubcallsPerRound: 25, discoverSubcalls: 25 },
    routes: (['keyword_posts', 'account_posts', 'post_detail'] as const).map(kind => ({ platform: 'youtube', kind, vendor: 'tikhub',
      route: tikhubRouteId('youtube', kind), backup: null, maxUnitsPerCall: '1' })) });
  const sent: SupplierRequest[] = [];
  subcall.mockImplementation(async (context, request) => {
    const operationId = context.newId();
    sent.push(request);
    if (request.vendor !== 'tikhub') throw new Error('unexpected vendor');
    const { kind, keyword, postId } = request.call;
    const body = kind === 'keyword_posts' ? keywordAnswer(keyword!)
      : detailAnswer(postId!, strangerFor !== undefined && postId!.endsWith(String(strangerFor).padStart(5, '0')));
    const items: ResearchItem[] = normalizeTikhub(body, 'youtube', kind);
    operations.set(operationId, { state: 'succeeded', identityHash: requestIdentity(request),
      result: { items, outcome: 'ok', reason: null, fetchedAt: now.toISOString(), truncated: false } });
    return { sent: true, operationId, callId: id, result: { vendor: 'tikhub', route: request.route, outcome: 'ok', reason: null,
      httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items, truncated: false, fetchedAt: now.toISOString() } };
  });
  const subcallContext = { policies: [], billing: { runId: id, claim: vi.fn(), dispatch: vi.fn(), record: vi.fn() }, evidence,
    nextSequence: vi.fn(), phase: 'question', secrets: vi.fn(), rateCounter: vi.fn(), newId: vi.fn() } as unknown as SubcallContext;
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config, store,
    subcall: subcallContext, emit: vi.fn(), now: () => now };
  return { ctx, store, sent };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('YouTube benchmark discovery', () => {
  it('screens each channel by one of its own found videos and shows the channels on a candidate card', async () => {
    const f = fixture();
    const envelope = JSON.parse(await discover(f.ctx, { keywordConfirmationId: id, platforms: ['youtube'] } as never,
      { left: 25, used: 0 }));
    expect(f.sent.slice(0, 3).map(r => r.vendor === 'tikhub' && r.call.kind)).toEqual(['keyword_posts', 'keyword_posts', 'keyword_posts']);
    const details = f.sent.slice(3);
    expect(details.length).toBeGreaterThanOrEqual(8);
    for (const request of details) {
      if (request.vendor !== 'tikhub') throw new Error('vendor');
      expect(request.call).toMatchObject({ platform: 'youtube', kind: 'post_detail' });
      // The video is the channel's own (first found) video: same index in id and channel.
      expect(request.call.account).toBe(channel(Number(request.call.postId!.slice(-5))));
    }
    expect(envelope).toMatchObject({ candidateCard: { shown: true } });
    const options = vi.mocked(f.store.createCard).mock.calls[0]![1].options as Array<{ platform: string; account: string; label: string }>;
    expect(options.length).toBeGreaterThanOrEqual(8);
    expect(options.every(option => option.platform === 'youtube' && /^UC/.test(option.account))).toBe(true);
    expect(options[0]!.label).toMatch(/^Channel \d · 活跃度待核对$/);
  });

  it('never lets another channel\'s video detail screen an author', async () => {
    const f = fixture(0);
    const envelope = JSON.parse(await discover(f.ctx, { keywordConfirmationId: id, platforms: ['youtube'] } as never,
      { left: 25, used: 0 }));
    const accounts = (envelope.items as Array<{ fields: { account: string } }>).map(item => item.fields.account);
    expect(accounts).not.toContain(channel(0));
    expect(accounts).not.toContain(channel(99));
    expect(accounts.length).toBe(8);
  });
});
