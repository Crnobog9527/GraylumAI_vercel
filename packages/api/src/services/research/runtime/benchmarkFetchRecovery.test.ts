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
const account = { platform: 'tiktok' as const, account: 'alice' };
const args = { accounts: [account], source: { kind: 'candidate' as const, confirmationId: id } };
const now = new Date('2026-10-15T00:00:00.000Z');
const kinds = ['account_profile', 'account_posts'] as const;

function fixture() {
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  const config = researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: ['tiktok'], benchmarkPlatforms: ['tiktok'],
    routes: kinds.map(kind => ({ platform: 'tiktok', kind, vendor: 'tikhub', route: tikhubRouteId('tiktok', kind),
      backup: null, maxUnitsPerCall: '1' })),
  });
  const policies: ToolCallPolicy[] = kinds.map(kind => ({
    provider: 'tikhub', account: 'tikhub-main', model: `tikhub:${tikhubRouteId('tiktok', kind)}`,
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
  const tikhub = vi.fn<VendorCalls['tikhub']>(async (call): Promise<ResearchCallResult> => ({
    vendor: 'tikhub', route: tikhubRouteId(call.platform, call.kind)!, outcome: 'ok', reason: null, httpStatus: 200,
    supplierMayCharge: true, usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: now.toISOString(),
    items: [{ fields: call.kind === 'account_profile' ? { followers: 50000 }
      : { id: 'post', publishedAt: now.toISOString(), views: 50000, likes: 100, comments: 20, shares: 5 }, missing: [] }],
  }));
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config, store,
    emit: vi.fn(), now: () => now, subcall: { policies, billing, evidence, nextSequence: () => sequence + 1,
      phase: 'question', secrets: async () => 'test-key', rateCounter: async () => true,
      newId: () => id, now: () => now, vendors: { tikhub, parallel: vi.fn(), firecrawl: vi.fn() } } };
  const run = () => benchmarkFetch(ctx, args, { left: 10, used: 0 });
  return { ctx, run, evidence, billing, tikhub, fetchClaim, fetchDispatch, fetchFinish, operations };
}

describe('benchmark prepared fetch recovery uses database attempt rotation', () => {
  it.each(['false', 'throw'] as const)('recovers after beforeSend %s with a new stable operation', async mode => {
    const f = fixture();
    f.ctx.subcall.beforeSend = mode === 'throw' ? vi.fn().mockRejectedValue(new Error('pre-send failure'))
      : vi.fn().mockResolvedValue(false);
    if (mode === 'throw') await expect(f.run()).rejects.toThrow('pre-send failure');
    else expect(JSON.parse(await f.run())).toMatchObject({ status: 'partial' });
    const oldId = stableResearchId(id, 'attempt-1', 'account_profile');
    expect(f.operations.get(oldId)).toMatchObject({ state: 'failed', result: {
      outcome: 'not_sent', supplierMayCharge: false, cost: { actual: 0 },
    } });
    expect(f.tikhub).not.toHaveBeenCalled();
    expect(f.fetchDispatch).not.toHaveBeenCalled();
    expect(f.fetchFinish).not.toHaveBeenCalled();
    f.ctx.subcall.beforeSend = vi.fn().mockResolvedValue(true);
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'ok' });
    const newId = stableResearchId(id, 'attempt-2', 'account_profile');
    expect(newId).not.toBe(oldId);
    expect(f.operations.get(newId)?.state).toBe('succeeded');
    expect(f.evidence.open.mock.calls.filter(([operationId]) => operationId === oldId)).toHaveLength(1);
    expect(f.tikhub).toHaveBeenCalledTimes(2);
    expect(f.fetchClaim).toHaveBeenCalledTimes(2);
  });

  it('never resends an unknown supplier attempt on another tool invocation', async () => {
    const f = fixture();
    f.tikhub.mockRejectedValueOnce(new Error('supplier timed out after send'));
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'partial' });
    expect(f.fetchFinish).toHaveBeenCalledWith(id, 'attempt-1', 'unknown', null);
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'partial' });
    expect(f.tikhub).toHaveBeenCalledTimes(1);
    expect(f.billing.claim).toHaveBeenCalledTimes(1);
    expect(f.evidence.open).toHaveBeenCalledTimes(1);
  });
});


describe('benchmark cached evidence does not consume a supplier allowance', () => {
  it('returns paid cached evidence through the tool factory with no allowance remaining', async () => {
    const f = fixture();
    f.ctx.config.limits.maxSubcallsPerRound = 0;
    const cached = { ...account, metrics: { followers: 50000 }, fetchedAt: now.toISOString() };
    f.fetchClaim.mockResolvedValue({ claimed: false, fetchId: id, state: 'succeeded', evidence: cached });
    const tool = researchRuntimeTools(f.ctx).find(tool => tool.name === 'benchmark_fetch')!;
    const result = JSON.parse(await tool.execute(args, 'cached-call'));
    expect(result).toMatchObject({ status: 'ok', reason: null });
    expect(result.items).toHaveLength(1);
    expect(JSON.parse(result.items[0].fields.evidence)).toEqual(cached);
    expect(f.fetchClaim).toHaveBeenCalledTimes(1);
    expect(f.fetchDispatch).not.toHaveBeenCalled();
    expect(f.billing.claim).not.toHaveBeenCalled();
    expect(f.tikhub).not.toHaveBeenCalled();
  });

  it('keeps newly claimed work unsent when the remaining allowance is zero', async () => {
    const f = fixture();
    f.ctx.config.limits.maxSubcallsPerRound = 0;
    const tool = researchRuntimeTools(f.ctx).find(tool => tool.name === 'benchmark_fetch')!;
    expect(JSON.parse(await tool.execute(args, 'new-call')))
      .toMatchObject({ status: 'budget_exhausted', reason: 'ROUND_LIMIT', items: [] });
    expect(f.fetchClaim).toHaveBeenCalledTimes(1);
    expect(f.fetchDispatch).not.toHaveBeenCalled();
    expect(f.fetchFinish).not.toHaveBeenCalled();
    expect(f.billing.claim).not.toHaveBeenCalled();
    expect(f.evidence.open).not.toHaveBeenCalled();
    expect(f.tikhub).not.toHaveBeenCalled();
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'ok' });
  });
});

describe('benchmark fetch: the 20-post minimum and its new-account exception (Owner 2026-10-16, A)', () => {
  const respond = (f: ReturnType<typeof fixture>, profile: Record<string, number>, posts: number) =>
    f.tikhub.mockImplementation(async call => ({
      vendor: 'tikhub', route: tikhubRouteId(call.platform, call.kind)!, outcome: 'ok', reason: null, httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: now.toISOString(),
      items: call.kind === 'account_profile' ? [{ fields: profile, missing: [] }]
        : Array.from({ length: Math.abs(posts) }, (_, i) => ({ fields: { id: posts < 0 ? 'same' : `p${i}`, publishedAt: now.toISOString(), views: 900,
          likes: 10, comments: 2, shares: 1 }, missing: [] })),
    }));
  const saved = (f: ReturnType<typeof fixture>) => f.fetchFinish.mock.calls.at(-1)![3] as
    { metrics: { wholeHistory: boolean; postsAnalyzed: number }; classification: { qualified: boolean; excluded: string | null } };

  it.each([
    ['the profile reports exactly these posts (a new account)', { followers: 50000, postsCount: 3 }, 3, true, null],
    ['the profile reports more posts than were returned', { followers: 50000, postsCount: 40 }, 3, false, 'TOO_FEW_POSTS'],
    ['the profile has no post count', { followers: 50000 }, 3, false, 'TOO_FEW_POSTS'],
    ['20 posts were analyzed', { followers: 50000, postsCount: 400 }, 20, true, null],
    ['repeated entries of one post are not a whole history', { followers: 50000, postsCount: 3 }, -3, false, 'TOO_FEW_POSTS'],
  ] as const)('%s', async (_case, profile, posts, qualified, excluded) => {
    const f = fixture();
    respond(f, profile, posts);
    expect(JSON.parse(await f.run())).toMatchObject({ status: 'ok' });
    expect(saved(f).metrics.postsAnalyzed).toBe(posts < 0 ? 1 : posts);
    expect(saved(f).classification).toMatchObject({ qualified, excluded });
    expect(saved(f).metrics.wholeHistory).toBe('postsCount' in profile && posts > 0 && profile.postsCount <= posts);
  });
});
