/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import type { ToolSubcallBilling } from '../../bill2/toolSubcall';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../vendors/config';
import { tikhubRouteId } from '../vendors/tikhub';
import type { ResearchCallResult } from '../vendors/types';
import { benchmarkFetch } from './benchmarkFetch';
import { researchRuntimeTools } from '../../runtime/researchRuntimeTool';
import type { FetchClaim, FetchState, RuntimeResearchStore } from './store';
import type { EvidencePort, VendorCalls } from './subcall';
import { stableResearchId, type ResearchToolContext } from './toolContext';

const id = '11111111-1111-4111-8111-111111111111';
const account = { platform: 'xiaohongshu' as const, account: '0123456789abcdef01234567' };
const args = { accounts: [account], source: { kind: 'candidate' as const, confirmationId: id } };
const now = new Date('2026-10-15T00:00:00.000Z');
const kinds = ['account_profile', 'account_posts'] as const;

function fixture() {
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  const config = researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: ['xiaohongshu'], benchmarkPlatforms: ['xiaohongshu'],
    routes: kinds.map(kind => ({ platform: 'xiaohongshu', kind, vendor: 'tikhub', route: tikhubRouteId('xiaohongshu', kind),
      backup: null, maxUnitsPerCall: '1' })),
  });
  const policies: ToolCallPolicy[] = kinds.map(kind => ({
    provider: 'tikhub', account: 'tikhub-main', model: `tikhub:${tikhubRouteId('xiaohongshu', kind)}`,
    protocol: 'research-tool-v1', modelId: id, multiplier: '6', lookupSupported: false, upperUsd: '0.01', purposes: ['question'],
    toolPricing: { unit: 'call', currency: 'USD', price: '0.01', unitsPerPrice: '1', usdPerCurrency: null,
      entryHash: 'a'.repeat(64), validUntil: '2026-12-01T00:00:00Z', maxUnitsPerCall: '1' },
  }));
  const operations = new Map<string, { state: string; result?: unknown }>();
  const evidence = {
    // 0065 research_transition: reserve keeps a prepared operation; dispatch moves it on once.
    open: vi.fn<EvidencePort['open']>(async operationId => {
      const prior = operations.get(operationId);
      if (prior && prior.state !== 'prepared') return null;
      operations.set(operationId, { state: 'prepared' });
      return { token: 'token' };
    }),
    dispatch: vi.fn<EvidencePort['dispatch']>(async operationId => {
      if (operations.get(operationId)?.state !== 'prepared') return false;
      operations.set(operationId, { state: 'dispatched' });
      return true;
    }),
    finish: vi.fn<EvidencePort['finish']>(async (operationId, _token, state, result) => {
      if (operations.get(operationId)?.state !== 'dispatched') throw new Error('invalid finish');
      operations.set(operationId, { state, result });
    }),
    cancel: vi.fn<EvidencePort['cancel']>(async operationId => {
      if (operations.get(operationId)?.state === 'prepared') operations.set(operationId, { state: 'cancelled' });
    }),
    link: vi.fn<EvidencePort['link']>().mockResolvedValue(undefined),
  };
  let state: FetchState = 'prepared';
  let attempt = 0;
  const fetchClaim = vi.fn(async (): Promise<FetchClaim> => {
    // 0263 research_account_fetch_claim rotates attempt on every prepared takeover.
    // It never hands an in_progress/unknown/paid terminal fetch back to the caller.
    if (!['prepared', 'failed'].includes(state)) return { claimed: false, fetchId: id, state, evidence: null };
    state = 'prepared';
    return { claimed: true, fetchId: id, attempt: `attempt-${++attempt}` };
  });
  const fetchDispatch = vi.fn(async () => { state = 'in_progress'; return true; });
  const fetchFinish = vi.fn<RuntimeResearchStore['fetchFinish']>(async (_id, _attempt, finalState) => { state = finalState; });
  const store = { authorization: { candidateConfirmation: vi.fn().mockResolvedValue([account]) },
    evidence: () => evidence, fetchClaim, fetchDispatch, fetchFinish,
    callCharge: vi.fn().mockResolvedValue(null) } as unknown as RuntimeResearchStore;
  let sequence = 0;
  const billing = {
    runId: id,
    claim: vi.fn<ToolSubcallBilling['claim']>(async () => ({ state: 'claimed', callId: `call-${++sequence}`, token: 'token' })),
    dispatch: vi.fn<ToolSubcallBilling['dispatch']>().mockResolvedValue(true),
    record: vi.fn<ToolSubcallBilling['record']>().mockResolvedValue({ accountClosed: false, contentDeleted: false }),
  };
  // Pages of 8 notes; `pages` says how many pages exist (the last one has no next cursor).
  let pages = 3;
  const cursors = (page: number) => `6a00000000000000000000${String(page).padStart(2, '0')}`;
  const tikhub = vi.fn<VendorCalls['tikhub']>(async (call): Promise<ResearchCallResult> => {
    const page = call.cursor ? Number(call.cursor.slice(-2)) + 1 : 1;
    return { vendor: 'tikhub', route: tikhubRouteId(call.platform, call.kind)!, outcome: 'ok', reason: null, httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: now.toISOString(),
      ...(call.kind === 'account_posts' && page < pages ? { nextCursor: cursors(page) } : {}),
      items: call.kind === 'account_profile' ? [{ fields: { followers: 50000, postsCount: 400 }, missing: [] }]
        : Array.from({ length: 8 }, (_, i) => ({ fields: { id: `p${page}-${i}`, publishedAt: now.toISOString(), views: 50, likes: 100,
          comments: 20, shares: 5 }, missing: [] })) };
  });
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config, store,
    emit: vi.fn(), now: () => now, subcall: { policies, billing, evidence, nextSequence: () => sequence + 1,
      phase: 'question', secrets: async () => 'test-key', rateCounter: async () => true,
      newId: () => id, now: () => now, vendors: { tikhub, parallel: vi.fn(), firecrawl: vi.fn() } } };
  const run = (left = 10) => benchmarkFetch(ctx, args, { left, used: 0 });
  return { ctx, run, evidence, billing, tikhub, fetchClaim, fetchDispatch, fetchFinish, operations, setPages: (n: number) => { pages = n; } };
}


const saved = (f: ReturnType<typeof fixture>) => f.fetchFinish.mock.calls.at(-1)![3] as
  { metrics: { postsAnalyzed: number; wholeHistory: boolean }; classification: { qualified: boolean; excluded: string | null } };

describe('Xiaohongshu notes are paged by cursor until the 20-post rule can be judged', () => {
  it('follows the cursor, bills each page as its own sub-call and passes the 20-post rule', async () => {
    const f = fixture();
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'ok' });
    expect(f.tikhub).toHaveBeenCalledTimes(4); // profile + 3 pages of 8 notes
    expect(f.tikhub.mock.calls.filter(([call]) => call.kind === 'account_posts').map(([call]) => call.cursor))
      .toEqual([undefined, '6a0000000000000000000001', '6a0000000000000000000002']);
    expect(f.billing.claim).toHaveBeenCalledTimes(4);
    expect(saved(f).metrics.postsAnalyzed).toBe(24);
    expect(saved(f).classification).toMatchObject({ qualified: true, excluded: null });
    for (const page of ['account_posts']) {
      expect(f.operations.get(stableResearchId(id, 'attempt-1', page))?.state).toBe('succeeded');
      expect(f.operations.get(stableResearchId(id, 'attempt-1', page, '3'))?.state).toBe('succeeded');
    }
  });

  it('stops as soon as 20 notes are in hand', async () => {
    const f = fixture();
    f.setPages(9);
    await f.run();
    expect(f.tikhub).toHaveBeenCalledTimes(4);
    expect(saved(f).metrics.postsAnalyzed).toBe(24);
  });

  it('asks for no further page when the supplier says there is none (whole history of a small account)', async () => {
    const f = fixture();
    f.setPages(1);
    f.tikhub.mockImplementation(async call => ({ vendor: 'tikhub', route: tikhubRouteId(call.platform, call.kind)!, outcome: 'ok',
      reason: null, httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: now.toISOString(),
      items: call.kind === 'account_profile' ? [{ fields: { followers: 50000, postsCount: 8 }, missing: [] }]
        : Array.from({ length: 8 }, (_, i) => ({ fields: { id: `n${i}`, publishedAt: now.toISOString(), likes: 1 }, missing: [] })) }));
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'ok' });
    expect(f.tikhub).toHaveBeenCalledTimes(2);
    expect(saved(f).metrics.wholeHistory).toBe(true);
  });

  it('a page that fails midway keeps the account unjudged and charged, with no further request', async () => {
    const f = fixture();
    const original = f.tikhub.getMockImplementation()!;
    f.tikhub.mockImplementation(async (call, key) => call.cursor
      ? { ...(await original(call, key)), outcome: 'failed' as const, reason: 'HTTP_503', items: [], supplierMayCharge: false }
      : original(call, key));
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'partial' });
    expect(f.tikhub).toHaveBeenCalledTimes(3);
    expect(f.fetchFinish).toHaveBeenCalledWith(id, 'attempt-1', 'failed_charged', null);
  });

  it('needs room for the extra pages: a smaller allowance leaves the account unsent for the next round', async () => {
    const f = fixture();
    expect(JSON.parse(await f.run(3))).toMatchObject({ status: 'budget_exhausted', reason: 'ROUND_LIMIT', items: [] });
    expect(f.tikhub).not.toHaveBeenCalled();
    expect(f.billing.claim).not.toHaveBeenCalled();
  });

  it('through the real tool entry point: one Xiaohongshu account gets room for its extra pages in the default round', async () => {
    const f = fixture();
    expect(f.ctx.config.limits.maxSubcallsPerRound).toBe(12);
    const tool = researchRuntimeTools(f.ctx).find(tool => tool.name === 'benchmark_fetch')!;
    const result = JSON.parse(await tool.execute(args, 'paging-call'));
    expect(result).toMatchObject({ status: 'ok', reason: null });
    expect(f.tikhub).toHaveBeenCalledTimes(4);
    expect(saved(f).metrics.postsAnalyzed).toBe(24);
  });
});
