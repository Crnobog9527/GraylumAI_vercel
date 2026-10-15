/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchRuntimeTools } from './researchRuntimeTool';
import { requestIdentity, runSubcall, type SubcallContext } from '../research/runtime/subcall';
import { socialRequest, stableResearchId, type ResearchToolContext } from '../research/runtime/toolContext';
import type { DiscoveryRecord, FetchClaim, RuntimeOperation, RuntimePlan, RuntimeResearchStore } from '../research/runtime/store';
import type { ToolEnvelope } from '../research/tools/envelope';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../research/vendors/config';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { FIRECRAWL_ROUTE } from '../research/vendors/firecrawl';
import type { ResearchItem } from '../research/vendors/types';

vi.mock('../research/runtime/subcall', async importOriginal => ({
  ...await importOriginal<typeof import('../research/runtime/subcall')>(), runSubcall: vi.fn(),
}));
const subcall = vi.mocked(runSubcall);
const id = '11111111-1111-4111-8111-111111111111';
const discoveryId = '22222222-2222-4222-8222-222222222222';
const refreshId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-10-15T00:00:00Z');
const account = { platform: 'tiktok' as const, account: 'alice' };
const fetchArgs = { accounts: [account], source: { kind: 'candidate', confirmationId: id } };
const discoveryArgs = { keywordConfirmationId: id, platforms: ['tiktok'] };
const item = (fields: ResearchItem['fields']): ResearchItem => ({ fields, missing: [] });
const post = (authorId = 'alice') => item({ authorId, id: `post-${authorId}`, publishedAt: now.toISOString(),
  views: 50000, likes: 100, comments: 20, shares: 5 });

function config(limit = 12) {
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  return researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: ['tiktok'], benchmarkPlatforms: ['tiktok'],
    limits: { maxSubcallsPerRound: limit, discoverSubcalls: 25 },
    routes: [
      ...(['keyword_posts', 'account_profile', 'account_posts'] as const).map(kind => ({
        platform: 'tiktok', kind, vendor: 'tikhub', route: tikhubRouteId('tiktok', kind), backup: null, maxUnitsPerCall: '1',
      })),
      { platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' },
      { platform: 'web', kind: 'web_search_pro', vendor: 'parallel', route: 'parallel:search:advanced', backup: null, maxUnitsPerCall: '1' },
      { platform: 'web', kind: 'web_fetch', vendor: 'firecrawl', route: FIRECRAWL_ROUTE, backup: null, maxUnitsPerCall: '1' },
    ],
  });
}

function fixture(limit = 12) {
  const supplierCalls = vi.fn();
  const operations = new Map<string, RuntimeOperation>();
  const plans = new Map<string, RuntimePlan>();
  const discoveries = new Map<string, DiscoveryRecord>();
  const fetches = new Map<string, FetchClaim>();
  const evidence = { open: vi.fn().mockResolvedValue({ token: id }), finish: vi.fn(), link: vi.fn() };
  const store = {
    authorization: {
      keywordConfirmation: vi.fn<RuntimeResearchStore['authorization']['keywordConfirmation']>()
        .mockResolvedValue({ keywords: ['one', 'two', 'three'] }),
      candidateConfirmation: vi.fn<RuntimeResearchStore['authorization']['candidateConfirmation']>().mockResolvedValue([account]),
      userMessage: vi.fn<RuntimeResearchStore['authorization']['userMessage']>().mockResolvedValue(null),
      refreshGrant: vi.fn<RuntimeResearchStore['authorization']['refreshGrant']>().mockResolvedValue(null),
    },
    evidence: vi.fn<RuntimeResearchStore['evidence']>(() => evidence),
    readOperation: vi.fn<RuntimeResearchStore['readOperation']>(async key => operations.get(key) ?? null),
    readPlan: vi.fn<RuntimeResearchStore['readPlan']>(async key => plans.get(key) ?? null),
    cancelUnsentPlan: vi.fn<RuntimeResearchStore['cancelUnsentPlan']>(async key => {
      const plan = plans.get(key);
      if (plan) plans.set(key, { ...plan, cancelled: true });
      const op = operations.get(key);
      if (op?.state === 'prepared') operations.set(key, { ...op, state: 'cancelled' });
    }),
    createCard: vi.fn<RuntimeResearchStore['createCard']>(async (cardId, payload) => ({
      cardId, kind: payload.kind, options: payload.options, minSelect: payload.minSelect ?? 3, maxSelect: 5,
    })),
    confirmCard: vi.fn<RuntimeResearchStore['confirmCard']>(),
    discoveryStart: vi.fn<RuntimeResearchStore['discoveryStart']>(async (_confirmation, platforms) => {
      const record: DiscoveryRecord = { discoveryId, keywords: ['one', 'two', 'three'], platforms, cursor: {}, state: 'running' };
      discoveries.set(discoveryId, record);
      return record;
    }),
    discoveryRead: vi.fn<RuntimeResearchStore['discoveryRead']>(async key => discoveries.get(key) ?? null),
    discoverySave: vi.fn<RuntimeResearchStore['discoverySave']>(async (key, cursor, state) => {
      const record = { ...discoveries.get(key)!, cursor, state };
      discoveries.set(key, record);
      return record;
    }),
    selectedAccounts: vi.fn<RuntimeResearchStore['selectedAccounts']>().mockResolvedValue([]),
    fetchClaim: vi.fn<RuntimeResearchStore['fetchClaim']>(async (_platform, _account, refresh) => {
      if (!refresh && fetches.has('account')) return fetches.get('account')!;
      return { claimed: true, fetchId: id, attempt: refresh ?? 'first-attempt' };
    }),
    fetchDispatch: vi.fn<RuntimeResearchStore['fetchDispatch']>().mockResolvedValue(true),
    fetchFinish: vi.fn<RuntimeResearchStore['fetchFinish']>(async (fetchId, _attempt, state, saved) => {
      fetches.set('account', { claimed: false, fetchId, state, evidence: saved });
    }),
    refreshCreate: vi.fn<RuntimeResearchStore['refreshCreate']>().mockResolvedValue(refreshId),
  } satisfies RuntimeResearchStore;
  const dummySubcall: SubcallContext = {
    policies: [], billing: { runId: id, claim: vi.fn(), dispatch: vi.fn(), record: vi.fn() }, evidence,
    nextSequence: vi.fn(), phase: 'question', secrets: vi.fn(), rateCounter: vi.fn(), newId: vi.fn(),
  };
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id,
    config: config(limit), store, subcall: dummySubcall, emit: vi.fn(), now: () => now };
  let authorCount = 8;
  subcall.mockImplementation(async (context, request) => {
    const operationId = context.newId();
    if (context.beforeSend && !await context.beforeSend()) {
      return { sent: true, operationId, callId: id, result: { vendor: request.vendor, route: request.route,
        outcome: 'not_sent', reason: 'FETCH_NOT_DISPATCHED', httpStatus: null, supplierMayCharge: false,
        usage: { unit: 'call', units: '0' }, items: [], truncated: false, fetchedAt: now.toISOString() } };
    }
    context.onSupplierDispatch?.();
    supplierCalls(request);
    const items = request.vendor !== 'tikhub' ? [item({ title: 'web evidence' })]
      : request.call.kind === 'keyword_posts' ? Array.from({ length: authorCount }, (_, i) => post(`author${i}`))
      : request.call.kind === 'account_profile' ? [item({ followers: 50000 })] : [post()];
    operations.set(operationId, { state: 'succeeded', identityHash: requestIdentity(request),
      result: { items, outcome: 'ok', reason: null, fetchedAt: now.toISOString(), truncated: false } });
    return { sent: true, operationId, callId: id, result: { vendor: request.vendor, route: request.route,
      outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
      usage: { unit: 'call', units: '1' }, items, truncated: false, fetchedAt: now.toISOString() } };
  });
  const makeExecute = () => {
    const tools = researchRuntimeTools(ctx);
    return async (name: string, args: Record<string, unknown>, callId = 'tool-call'): Promise<ToolEnvelope> => {
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return JSON.parse(await tool.execute(args, callId)) as ToolEnvelope;
    };
  };
  return { ctx, store, operations, plans, discoveries, fetches, supplierCalls, makeExecute,
    execute: makeExecute(), setAuthors: (count: number) => { authorCount = count; } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('positioning research tool factory', () => {
  it('exposes exactly the six positioning tools with SDK object schemas', () => {
    const f = fixture();
    const tools = researchRuntimeTools(f.ctx);
    expect(tools.map(t => t.name)).toEqual(['propose_keywords', 'benchmark_discover', 'propose_more_candidates',
      'benchmark_fetch', 'web_search', 'web_fetch']);
    expect(tools.every(t => t.parameters && 'shape' in t.parameters)).toBe(true);
  });

  it.each([
    ['propose_keywords', { keywords: ['one', 'two', 'three'] }],
    ['benchmark_discover', discoveryArgs], ['propose_more_candidates', { discoveryId }],
    ['benchmark_fetch', fetchArgs], ['web_search', { query: 'public topic' }], ['web_fetch', { url: 'https://example.com' }],
  ] as const)('disabled config blocks %s without supplier or storage activity', async (name, args) => {
    const f = fixture();
    f.ctx.config.enabled = false;
    expect(await f.execute(name, args)).toMatchObject({ status: 'unavailable', reason: 'RESEARCH_DISABLED' });
    expect(subcall).not.toHaveBeenCalled();
    expect(f.store.createCard).not.toHaveBeenCalled();
    expect(f.store.discoveryRead).not.toHaveBeenCalled();
    expect(f.store.discoveryStart).not.toHaveBeenCalled();
    expect(f.store.fetchClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['web_search', { query: 'topic', vendor: 'untrusted' }], ['web_fetch', { url: 'http://127.0.0.1' }],
    ['propose_keywords', { keywords: ['one'] }], ['benchmark_discover', { discoveryId, ...discoveryArgs }],
  ])('rejects invalid %s without external calls', async (name, args) => {
    const f = fixture();
    expect(await f.execute(name as string, args as Record<string, unknown>)).toMatchObject({ status: 'not_confirmed', reason: 'INVALID_ARGUMENTS' });
    expect(subcall).not.toHaveBeenCalled();
  });

  it.each([
    ['web_search', { query: 'topic' }], ['web_fetch', { url: 'https://example.com' }],
  ])('replays durable %s evidence after worker loss without sending or spending another allowance', async (name, args) => {
    const f = fixture(1);
    const first = await f.execute(name as string, args, 'paid-call');
    expect(first.status).toBe('ok');
    // Same worker with exhausted allowance, then a fresh resumed worker reading persisted evidence.
    expect(await f.execute(name as string, args, 'paid-call')).toEqual(first);
    expect(await f.makeExecute()(name as string, args, 'paid-call')).toEqual(first);
    expect(f.supplierCalls).toHaveBeenCalledTimes(1);
    expect(subcall).toHaveBeenCalledTimes(1);
  });

  it('never resends or substitutes an incomplete, malformed, or mismatched web operation', async () => {
    const f = fixture();
    const operationId = stableResearchId(id, 'paid-call');
    await f.execute('web_search', { query: 'topic' }, 'paid-call');
    const prior = f.operations.get(operationId)!;
    for (const state of ['dispatched', 'unknown', 'failed', 'cancelled'] as const) {
      f.operations.set(operationId, { ...prior, state, result: null });
      expect(await f.makeExecute()('web_search', { query: 'topic' }, 'paid-call'))
        .toMatchObject({ status: 'unavailable', reason: 'PROVIDER_RESULT_UNKNOWN' });
    }
    f.operations.set(operationId, prior);
    expect(await f.makeExecute()('web_search', { query: 'different topic' }, 'paid-call'))
      .toMatchObject({ status: 'unavailable', reason: 'OPERATION_IDENTITY_MISMATCH' });
    expect(f.supplierCalls).toHaveBeenCalledTimes(1);
  });

  it('refuses discovery replay when the same operation index no longer describes the same request', async () => {
    const f = fixture();
    await f.execute('benchmark_discover', discoveryArgs);
    const sent = f.supplierCalls.mock.calls.length;
    const operationId = stableResearchId(discoveryId, '0');
    f.operations.set(operationId, { ...f.operations.get(operationId)!, identityHash: 'f'.repeat(64) });
    const resumed = await f.makeExecute()('benchmark_discover', { discoveryId });
    expect(resumed).toMatchObject({ status: 'unavailable', reason: 'OPERATION_IDENTITY_MISMATCH', continue: false, items: [] });
    expect(f.supplierCalls).toHaveBeenCalledTimes(sent);
  });

  it('requires real keyword and account authorization, not model-supplied identifiers', async () => {
    const f = fixture();
    f.store.authorization.keywordConfirmation.mockResolvedValue(null);
    f.store.authorization.candidateConfirmation.mockResolvedValue(null);
    expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({ status: 'not_confirmed' });
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'not_confirmed' });
    expect(await f.execute('benchmark_discover', { discoveryId })).toMatchObject({ reason: 'DISCOVERY_NOT_FOUND' });
    expect(f.store.fetchClaim).not.toHaveBeenCalled();
    expect(subcall).not.toHaveBeenCalled();
  });

  it('maps pro to advanced and shares the round allowance across web tools', async () => {
    const f = fixture(2);
    expect(await f.execute('web_search', { query: 'topic', mode: 'pro' }, 'search')).toMatchObject({ status: 'ok' });
    expect(subcall.mock.calls[0]?.[1]).toEqual({ vendor: 'parallel', route: 'parallel:search:advanced', query: 'topic', mode: 'advanced' });
    expect(await f.execute('web_fetch', { url: 'https://example.com' }, 'fetch')).toMatchObject({ status: 'ok' });
    expect(await f.execute('web_search', { query: 'topic' }, 'over-limit')).toMatchObject({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
    expect(subcall).toHaveBeenCalledTimes(2);
  });

  it('keeps keyword cards free after paid budget exhaustion, with stable scoped IDs', async () => {
    const f = fixture(1);
    await f.execute('web_search', { query: 'topic' });
    const args = { keywords: ['one', 'two', 'three'] };
    const first = await f.execute('propose_keywords', args, 'keywords');
    const resumed = await f.makeExecute()('propose_keywords', args, 'keywords');
    expect(first).toMatchObject({ status: 'ok' });
    expect(resumed).toEqual(first);
    expect(f.store.createCard.mock.calls[0]?.[0]).toBe(stableResearchId(id, 'keywords'));
    expect(f.store.createCard.mock.calls[1]?.[0]).toBe(f.store.createCard.mock.calls[0]?.[0]);
    expect(subcall).toHaveBeenCalledTimes(1);
    expect(f.ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'research_card' }));
  });

  it('rejects disabled vendors without consuming another tool allowance', async () => {
    const f = fixture(1);
    f.ctx.config.vendors.parallel.enabled = false;
    expect(await f.execute('web_search', { query: 'topic' })).toMatchObject({ reason: 'VENDOR_DISABLED' });
    expect(await f.execute('web_fetch', { url: 'https://example.com' })).toMatchObject({ status: 'ok' });
    expect(subcall).toHaveBeenCalledTimes(1);
  });
});

describe('benchmark fetch cache and refresh', () => {
  it('fetches once, reuses saved evidence for free, and passes a valid explicit refresh grant', async () => {
    const f = fixture();
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'ok' });
    expect(subcall).toHaveBeenCalledTimes(2);
    expect(f.store.fetchFinish).toHaveBeenCalledWith(id, 'first-attempt', 'succeeded', expect.objectContaining({ account: 'alice' }));
    const cached = await f.execute('benchmark_fetch', fetchArgs);
    expect(cached).toMatchObject({ status: 'ok' });
    expect(cached.items[0]?.fields.evidence).toContain('alice');
    expect(subcall).toHaveBeenCalledTimes(2);
    f.store.authorization.refreshGrant.mockResolvedValue({ ...account, used: false });
    expect(await f.execute('benchmark_fetch', { accounts: [account], source: { kind: 'refresh', refreshId } })).toMatchObject({ status: 'ok' });
    expect(f.store.fetchClaim).toHaveBeenLastCalledWith('tiktok', 'alice', refreshId);
    expect(subcall).toHaveBeenCalledTimes(4);
    expect(subcall.mock.calls[2]?.[0].newId()).not.toBe(subcall.mock.calls[0]?.[0].newId());
  });

  it('does not reuse a consumed refresh grant', async () => {
    const f = fixture();
    f.store.authorization.refreshGrant.mockResolvedValue({ ...account, used: true });
    expect(await f.execute('benchmark_fetch', { accounts: [account], source: { kind: 'refresh', refreshId } }))
      .toMatchObject({ status: 'not_confirmed', reason: 'REFRESH_USED' });
    expect(subcall).not.toHaveBeenCalled();
    expect(f.store.fetchClaim).not.toHaveBeenCalled();
  });

  it('records unknown and does not automatically resend it on a later fetch', async () => {
    const f = fixture();
    subcall.mockImplementationOnce(async (context, request) => {
      await context.beforeSend?.();
      context.onSupplierDispatch?.();
      f.supplierCalls(request);
      return { sent: true, operationId: context.newId(), callId: id,
      result: { vendor: request.vendor, route: request.route, outcome: 'unknown', reason: 'TIMEOUT', httpStatus: null,
        supplierMayCharge: true, usage: { unit: 'call', units: null }, items: [], truncated: false, fetchedAt: now.toISOString() } }; });
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(f.store.fetchFinish).toHaveBeenCalledWith(id, 'first-attempt', 'unknown', null);
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(subcall).toHaveBeenCalledTimes(1);
  });

  it('requires enough budget for the whole account before dispatching its paid fetch', async () => {
    const f = fixture(1);
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
    expect(f.store.fetchClaim).toHaveBeenCalledTimes(1);
    expect(f.store.fetchDispatch).not.toHaveBeenCalled();
    expect(subcall).not.toHaveBeenCalled();
  });

  it('fails closed when account dispatch is denied', async () => {
    const f = fixture();
    f.store.fetchDispatch.mockResolvedValue(false);
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(subcall).toHaveBeenCalledTimes(1);
    expect(f.supplierCalls).not.toHaveBeenCalled();
  });

  it.each(['VENDOR_RATE_LIMITED', 'KEY_MISSING', 'BALANCE_LOW'] as const)(
    'keeps an unsent %s refresh prepared for a later retry', async stop => {
    const f = fixture();
    f.store.authorization.refreshGrant.mockResolvedValue({ ...account, used: false });
    subcall.mockResolvedValueOnce({ sent: false, stop, budget: stop !== 'KEY_MISSING' });
    const args = { accounts: [account], source: { kind: 'refresh', refreshId } };
    expect(await f.execute('benchmark_fetch', args)).toMatchObject({
      status: stop === 'KEY_MISSING' ? 'unavailable' : 'budget_exhausted', reason: stop,
    });
    expect(f.store.fetchDispatch).not.toHaveBeenCalled();
    expect(f.store.fetchFinish).not.toHaveBeenCalled();
    expect(f.supplierCalls).not.toHaveBeenCalled();
    expect(await f.makeExecute()('benchmark_fetch', args)).toMatchObject({ status: 'ok' });
    expect(f.store.fetchDispatch).toHaveBeenCalledWith(id, refreshId);
  });

  it('retains fetched profile data and the balance stop without trying another account', async () => {
    const f = fixture();
    const secondAccount = { ...account, account: 'bob' };
    f.store.authorization.candidateConfirmation.mockResolvedValue([account, secondAccount]);
    const successful = subcall.getMockImplementation()!;
    subcall.mockImplementationOnce(successful).mockResolvedValueOnce({ sent: false, stop: 'BALANCE_LOW', budget: true });
    const result = await f.execute('benchmark_fetch', { ...fetchArgs, accounts: [account, secondAccount] });
    expect(result).toMatchObject({ status: 'partial', reason: 'BALANCE_LOW' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].fields.account).toBe('alice');
    expect(f.store.fetchClaim).toHaveBeenCalledTimes(1);
    expect(subcall).toHaveBeenCalledTimes(2);
  });

  it.each(['claim', 'rate-limit', 'evidence-open'])('keeps the original refresh recoverable on pre-send %s errors', async stage => {
    const f = fixture();
    f.store.authorization.refreshGrant.mockResolvedValue({ ...account, used: false });
    const failure = new Error(`${stage} unavailable`);
    subcall.mockRejectedValueOnce(failure);
    const args = { accounts: [account], source: { kind: 'refresh', refreshId } };
    await expect(f.execute('benchmark_fetch', args)).rejects.toBe(failure);
    expect(f.store.fetchDispatch).not.toHaveBeenCalled();
    expect(f.store.fetchFinish).not.toHaveBeenCalled();
    expect(f.supplierCalls).not.toHaveBeenCalled();
    expect(f.fetches.size).toBe(0);
    expect(await f.makeExecute()('benchmark_fetch', args)).toMatchObject({ status: 'ok' });
    expect(f.store.fetchClaim.mock.calls).toEqual([
      ['tiktok', 'alice', refreshId], ['tiktok', 'alice', refreshId],
    ]);
    expect(f.store.fetchDispatch).toHaveBeenCalledTimes(1);
    expect(f.store.fetchDispatch).toHaveBeenCalledWith(id, refreshId);
    expect(f.store.fetchFinish).toHaveBeenCalledWith(id, refreshId, 'succeeded', expect.any(Object));
    expect(f.supplierCalls).toHaveBeenCalledTimes(2);
  });

});

describe('durable benchmark discovery and free follow-up', () => {
  it.each(['VENDOR_RATE_LIMITED', 'KEY_MISSING', 'BALANCE_LOW', 'NOT_DISPATCHED'] as const)(
    'preserves discovery stop %s without requesting automatic continuation', async stop => {
      const f = fixture();
      const budget = stop === 'BALANCE_LOW' || stop === 'VENDOR_RATE_LIMITED';
      subcall.mockResolvedValueOnce({ sent: false, stop, budget });
      expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({
        status: budget ? 'budget_exhausted' : 'unavailable', reason: stop, continue: false, discoveryId,
      });
      expect(subcall).toHaveBeenCalledTimes(1);
      expect(f.supplierCalls).not.toHaveBeenCalled();
      expect(f.discoveries.get(discoveryId)?.state).toBe('running');
    });

  it('keeps already discovered accounts when balance runs out, without automatic continuation', async () => {
    const f = fixture();
    const successful = subcall.getMockImplementation()!;
    subcall.mockImplementation(async (context, request) => context.newId() === stableResearchId(discoveryId, '4')
      ? { sent: false, stop: 'BALANCE_LOW', budget: true } : successful(context, request));
    const result = await f.execute('benchmark_discover', discoveryArgs);
    expect(result).toMatchObject({ status: 'partial', reason: 'BALANCE_LOW', continue: false });
    expect(result.items).toHaveLength(1);
    expect(subcall).toHaveBeenCalledTimes(5);
    expect(f.store.createCard).not.toHaveBeenCalled();
  });

  it('resumes across rounds from stable operation IDs without resending completed searches', async () => {
    const f = fixture(2);
    expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({ status: 'partial', continue: true, discoveryId });
    const sent = subcall.mock.calls.map(([ctx]) => ctx.newId());
    expect(sent).toEqual([stableResearchId(discoveryId, '0'), stableResearchId(discoveryId, '1')]);
    await f.makeExecute()('benchmark_discover', { discoveryId });
    const allSent = subcall.mock.calls.map(([ctx]) => ctx.newId());
    expect(new Set(allSent).size).toBe(allSent.length);
    expect(allSent.slice(2)).toEqual([stableResearchId(discoveryId, '2'), stableResearchId(discoveryId, '3')]);
    expect(f.store.discoveryStart).toHaveBeenCalledTimes(1);
  });

  it.each(['dispatched', 'unknown', 'failed'] as const)('does not resend a %s operation on discovery resume', async state => {
    const f = fixture();
    f.discoveries.set(discoveryId, { discoveryId, keywords: ['one'], platforms: ['tiktok'], cursor: {}, state: 'running' });
    f.operations.set(stableResearchId(discoveryId, '0'), { state, identityHash: requestIdentity(socialRequest(f.ctx, 'tiktok', 'keyword_posts', { keyword: 'one' })!) });
    expect(await f.execute('benchmark_discover', { discoveryId })).toMatchObject({ status: 'partial', continue: false });
    expect(subcall).not.toHaveBeenCalled();
    expect(f.store.createCard).not.toHaveBeenCalled();
  });

  it.each(['prepared', 'not-reserved'] as const)('recovers a prior execution %s plan through one stable successor', async state => {
    const f = fixture();
    f.setAuthors(0);
    f.discoveries.set(discoveryId, { discoveryId, keywords: ['one'], platforms: ['tiktok'], cursor: {}, state: 'running' });
    const oldId = stableResearchId(discoveryId, '0');
    const previousExecution = '44444444-4444-4444-8444-444444444444';
    f.plans.set(oldId, { executionId: previousExecution, discoveryId, budgetUnits: 1000, cancelled: false,
      operations: [{ operationId: oldId, identityHash: 'a'.repeat(64), maxQuoteUnits: 1000 }] });
    if (state === 'prepared') f.operations.set(oldId, { state: 'prepared', executionId: previousExecution });
    await f.execute('benchmark_discover', { discoveryId });
    const successor = stableResearchId(oldId, 'unsent-successor');
    expect(f.store.cancelUnsentPlan).toHaveBeenCalledWith(oldId);
    expect(f.store.cancelUnsentPlan.mock.invocationCallOrder[0]).toBeLessThan(subcall.mock.invocationCallOrder[0]!);
    expect(subcall).toHaveBeenCalledTimes(1);
    expect(subcall.mock.calls[0]?.[0].newId()).toBe(successor);
    expect(f.plans.get(oldId)).toMatchObject({ executionId: previousExecution, cancelled: true });
    expect(subcall.mock.calls.some(([ctx]) => ctx.newId() === oldId)).toBe(false);
    await f.makeExecute()('benchmark_discover', { discoveryId });
    expect(subcall).toHaveBeenCalledTimes(1);
  });

  it('does not create a successor if cancellation races with dispatch by the previous execution', async () => {
    const f = fixture();
    f.discoveries.set(discoveryId, { discoveryId, keywords: ['one'], platforms: ['tiktok'], cursor: {}, state: 'running' });
    const oldId = stableResearchId(discoveryId, '0');
    f.plans.set(oldId, { executionId: refreshId, discoveryId, budgetUnits: 1000, cancelled: false,
      operations: [{ operationId: oldId, identityHash: 'a'.repeat(64), maxQuoteUnits: 1000 }] });
    f.operations.set(oldId, { state: 'prepared', executionId: refreshId });
    f.store.cancelUnsentPlan.mockImplementation(async key => {
      f.plans.set(key, { ...f.plans.get(key)!, cancelled: true });
      f.operations.set(key, { state: 'dispatched', executionId: refreshId,
        identityHash: requestIdentity(socialRequest(f.ctx, 'tiktok', 'keyword_posts', { keyword: 'one' })!) });
    });
    expect(await f.execute('benchmark_discover', { discoveryId })).toMatchObject({ status: 'partial' });
    expect(f.store.cancelUnsentPlan).toHaveBeenCalledWith(oldId);
    expect(subcall).not.toHaveBeenCalled();
    expect(f.store.readOperation).not.toHaveBeenCalledWith(stableResearchId(oldId, 'unsent-successor'));
    expect(f.store.createCard).not.toHaveBeenCalled();
  });

  it('does not transfer an old plan if cancellation cannot be confirmed', async () => {
    const f = fixture();
    f.discoveries.set(discoveryId, { discoveryId, keywords: ['one'], platforms: ['tiktok'], cursor: {}, state: 'running' });
    const oldId = stableResearchId(discoveryId, '0');
    f.plans.set(oldId, { executionId: refreshId, discoveryId, budgetUnits: 1000, cancelled: false,
      operations: [{ operationId: oldId, identityHash: 'a'.repeat(64), maxQuoteUnits: 1000 }] });
    f.operations.set(oldId, { state: 'prepared', executionId: refreshId });
    f.store.cancelUnsentPlan.mockResolvedValue(undefined);
    await f.execute('benchmark_discover', { discoveryId });
    expect(subcall).not.toHaveBeenCalled();
  });

  it('withholds the initial selection card below eight qualified accounts', async () => {
    const f = fixture();
    f.setAuthors(7);
    expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({ status: 'partial', reason: 'NOT_ENOUGH_CANDIDATES' });
    expect(f.store.createCard).not.toHaveBeenCalled();
    expect(subcall).toHaveBeenCalledTimes(10);
  });

  it('creates a stable initial card and excludes already selected accounts from a free follow-up', async () => {
    const f = fixture(11);
    expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({ status: 'ok', continue: false });
    expect(f.store.createCard.mock.calls[0]?.[0]).toBe(stableResearchId(discoveryId, 'first-card'));
    expect(f.store.createCard.mock.calls[0]?.[1].options).toHaveLength(8);
    expect(subcall).toHaveBeenCalledTimes(11);
    f.store.selectedAccounts.mockResolvedValue([{ platform: 'tiktok', account: 'author0' }]);
    expect(await f.execute('propose_more_candidates', { discoveryId }, 'more')).toMatchObject({ status: 'ok' });
    const payload = f.store.createCard.mock.calls[1]?.[1];
    expect(payload).toMatchObject({ followUp: true, minSelect: 2 });
    expect(payload?.options).toHaveLength(7);
    expect(payload?.options.some(option => option.account === 'author0')).toBe(false);
    expect(f.store.createCard.mock.calls[1]?.[0]).toBe(stableResearchId(discoveryId, 'more'));
    expect(subcall).toHaveBeenCalledTimes(11);
  });
});

describe('full 25-subcall benchmark discovery', () => {
  it.each([false, true])('reuses durable evidence across 12-call rounds (middle profile unknown: %s)', async unknown => {
    const f = fixture(12);
    const keywords = ['one', 'two', 'three', 'four', 'five'];
    f.ctx.config = researchToolsConfigSchema.parse({ ...f.ctx.config,
      verifiedPlatforms: ['tiktok', 'x'], benchmarkPlatforms: ['tiktok', 'x'],
      routes: [...f.ctx.config.routes,
        ...(['keyword_posts', 'account_profile', 'account_posts'] as const).map(kind => ({
          platform: 'x', kind, vendor: 'tikhub', route: tikhubRouteId('x', kind), backup: null, maxUnitsPerCall: '1',
        })),
      ],
    });
    f.store.authorization.keywordConfirmation.mockResolvedValue({ keywords });
    f.store.discoveryStart.mockImplementation(async (_confirmation, platforms) => {
      const d: DiscoveryRecord = { discoveryId, keywords, platforms, cursor: {}, state: 'running' };
      f.discoveries.set(discoveryId, d);
      return d;
    });
    const successfulCall = subcall.getMockImplementation()!;
    subcall.mockImplementation(async (context, request) => {
      const outcome = await successfulCall(context, request);
      if (!unknown || context.newId() !== stableResearchId(discoveryId, '13') || !outcome.sent) return outcome;
      f.operations.set(context.newId(), { state: 'unknown', identityHash: requestIdentity(request), result: { items: [] } });
      return { ...outcome, result: { ...outcome.result, outcome: 'unknown', reason: 'TIMEOUT', httpStatus: null,
        items: [], usage: { ...outcome.result.usage, units: null } } };
    });

    expect(await f.execute('benchmark_discover', { keywordConfirmationId: id, platforms: ['tiktok', 'x'] }))
      .toMatchObject({ status: 'partial', reason: 'ROUND_LIMIT', continue: true });
    expect(subcall).toHaveBeenCalledTimes(12);
    expect(f.store.createCard).not.toHaveBeenCalled();
    const firstIds = subcall.mock.calls.map(([context]) => context.newId());

    f.ctx.executionId = refreshId;
    expect(await f.makeExecute()('benchmark_discover', { discoveryId }))
      .toMatchObject({ status: 'partial', reason: 'ROUND_LIMIT', continue: true });
    expect(subcall).toHaveBeenCalledTimes(24);
    expect(f.store.createCard).not.toHaveBeenCalled();

    f.ctx.executionId = '44444444-4444-4444-8444-444444444444';
    const completed = await f.makeExecute()('benchmark_discover', { discoveryId });
    expect(completed).toMatchObject({ status: unknown ? 'partial' : 'ok',
      reason: unknown ? 'DISCOVERY_PARTIAL' : null, continue: false });
    expect(subcall).toHaveBeenCalledTimes(25);
    expect(f.discoveries.get(discoveryId)).toMatchObject({ state: 'completed', cursor: { attempted: 25 } });

    const requests = subcall.mock.calls.map(([, request]) => request);
    const searches = requests.filter(request => request.vendor === 'tikhub' && request.call.kind === 'keyword_posts');
    const profiles = requests.filter(request => request.vendor === 'tikhub' && request.call.kind === 'account_profile');
    expect(searches).toHaveLength(10);
    expect(profiles).toHaveLength(15);
    for (const platform of ['tiktok', 'x']) {
      expect(searches.flatMap(request => request.vendor === 'tikhub' && request.call.platform === platform
        ? [request.call.keyword] : [])).toEqual(keywords);
    }
    // Five searches per platform all contain the same eight authors: each chosen author is fetched only once.
    const profileKeys = profiles.flatMap(request => request.vendor === 'tikhub'
      ? [`${request.call.platform}:${request.call.account}`] : []);
    expect(new Set(profileKeys).size).toBe(15);
    expect(profileKeys).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `tiktok:author${i}`),
      ...Array.from({ length: 7 }, (_, i) => `x:author${i}`),
    ]);
    const allIds = subcall.mock.calls.map(([context]) => context.newId());
    expect(allIds).toEqual(Array.from({ length: 25 }, (_, i) => stableResearchId(discoveryId, String(i))));
    expect(new Set(allIds).size).toBe(25);
    for (const operationId of firstIds) expect(f.store.readOperation).toHaveBeenCalledWith(operationId);
    const candidates = f.store.createCard.mock.calls[0]?.[1].options ?? [];
    expect(candidates.filter(option => option.selectable).length).toBeGreaterThanOrEqual(8);
    expect(f.store.createCard.mock.calls[0]?.[0]).toBe(stableResearchId(discoveryId, 'first-card'));

    // A further recovery reads the same completed evidence, including unknown, without buying any more calls.
    expect(await f.makeExecute()('benchmark_discover', { discoveryId })).toMatchObject({
      status: unknown ? 'partial' : 'ok', continue: false,
    });
    expect(subcall).toHaveBeenCalledTimes(25);
    expect(f.store.discoveryStart).toHaveBeenCalledTimes(1);
  });
});


describe('discovery continues beyond an insufficient first author batch', () => {
  it('advances saved author progress and reuses paid operations until eight candidates qualify', async () => {
    const f = fixture(25);
    f.setAuthors(25);
    const original = subcall.getMockImplementation()!;
    subcall.mockImplementation(async (context, request) => {
      const outcome = await original(context, request);
      if (outcome.sent && request.vendor === 'tikhub' && request.call.kind === 'account_profile') {
        const number = Number(request.call.account?.replace('author', ''));
        // Only the last eight lexical authors qualify (first 15 include fewer than eight).
        const qualified = ['author3', 'author4', 'author5', 'author6', 'author7', 'author8', 'author9', 'author24']
          .includes(request.call.account ?? '');
        outcome.result.items = [item({ followers: qualified ? 50000 : 100 + number })];
        f.operations.set(context.newId(), { state: 'succeeded', identityHash: requestIdentity(request),
          result: { ...outcome.result } });
      }
      return outcome;
    });
    expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({ status: 'partial',
      reason: 'CANDIDATE_SCAN_INCOMPLETE', continue: true });
    expect(f.store.createCard).not.toHaveBeenCalled();
    expect(f.discoveries.get(discoveryId)?.cursor).toMatchObject({ authorCursor: 15, authorLimit: 25 });
    const firstIds = subcall.mock.calls.map(([context]) => context.newId());
    f.ctx.executionId = refreshId;
    expect(await f.makeExecute()('benchmark_discover', { discoveryId })).toMatchObject({ status: 'ok', continue: false });
    expect(subcall).toHaveBeenCalledTimes(28); // 3 keyword queries + 25 different authors across two rounds.
    const ids = subcall.mock.calls.map(([context]) => context.newId());
    expect(new Set(ids).size).toBe(28);
    expect(ids.slice(0, firstIds.length)).toEqual(firstIds);
    expect(f.store.createCard.mock.calls[0]?.[1].options).toHaveLength(8);
  });
});

describe('candidate card total option ceiling', () => {
  it('fits twelve qualified accounts plus head references into twelve total options', async () => {
    const f = fixture(20);
    f.setAuthors(15);
    const successfulCall = subcall.getMockImplementation()!;
    subcall.mockImplementation(async (context, request) => {
      const outcome = await successfulCall(context, request);
      if (outcome.sent && request.vendor === 'tikhub' && request.call.kind === 'account_profile'
        && ['author7', 'author8', 'author9'].includes(request.call.account ?? '')) {
        outcome.result.items = [item({ followers: 500000 })];
        f.operations.set(context.newId(), { state: 'succeeded', identityHash: requestIdentity(request), result: { items: outcome.result.items } });
      }
      return outcome;
    });
    expect(await f.execute('benchmark_discover', discoveryArgs)).toMatchObject({ status: 'ok' });
    const options = f.store.createCard.mock.calls[0]?.[1].options ?? [];
    expect(options).toHaveLength(12);
    expect(options.filter(option => option.selectable)).toHaveLength(9);
    expect(options.filter(option => !option.selectable)).toHaveLength(3);
    expect(options.filter(option => !option.selectable).map(option => option.account).sort())
      .toEqual(['author7', 'author8', 'author9']);
  });
});
