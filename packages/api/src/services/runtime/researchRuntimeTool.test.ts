/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchRuntimeTools } from './researchRuntimeTool';
import { runSubcall, type SubcallContext } from '../research/runtime/subcall';
import { stableResearchId, type ResearchToolContext } from '../research/runtime/toolContext';
import type { DiscoveryRecord, FetchClaim, RuntimeOperation, RuntimePlan, RuntimeResearchStore } from '../research/runtime/store';
import type { ToolEnvelope } from '../research/tools/envelope';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../research/vendors/config';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { FIRECRAWL_ROUTE } from '../research/vendors/firecrawl';
import type { ResearchItem } from '../research/vendors/types';

vi.mock('../research/runtime/subcall', () => ({ runSubcall: vi.fn() }));
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
    policies: [], billing: { claim: vi.fn(), dispatch: vi.fn(), record: vi.fn() }, evidence,
    nextSequence: vi.fn(), phase: 'question', secrets: vi.fn(), rateCounter: vi.fn(), newId: vi.fn(),
  };
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id,
    config: config(limit), store, subcall: dummySubcall, emit: vi.fn(), now: () => now };
  let authorCount = 8;
  subcall.mockImplementation(async (context, request) => {
    const operationId = context.newId();
    const items = request.vendor !== 'tikhub' ? [item({ title: 'web evidence' })]
      : request.call.kind === 'keyword_posts' ? Array.from({ length: authorCount }, (_, i) => post(`author${i}`))
      : request.call.kind === 'account_profile' ? [item({ followers: 50000 })] : [post()];
    operations.set(operationId, { state: 'succeeded', result: { items } });
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
  return { ctx, store, operations, plans, discoveries, fetches, makeExecute,
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
    subcall.mockImplementationOnce(async (context, request) => ({ sent: true, operationId: context.newId(), callId: id,
      result: { vendor: request.vendor, route: request.route, outcome: 'unknown', reason: 'TIMEOUT', httpStatus: null,
        supplierMayCharge: true, usage: { unit: 'call', units: null }, items: [], truncated: false, fetchedAt: now.toISOString() } }));
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(f.store.fetchFinish).toHaveBeenCalledWith(id, 'first-attempt', 'unknown', null);
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(subcall).toHaveBeenCalledTimes(1);
  });

  it('requires enough budget for the whole account before claiming its paid fetch', async () => {
    const f = fixture(1);
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(f.store.fetchClaim).not.toHaveBeenCalled();
    expect(subcall).not.toHaveBeenCalled();
  });

  it('fails closed when account dispatch is denied', async () => {
    const f = fixture();
    f.store.fetchDispatch.mockResolvedValue(false);
    expect(await f.execute('benchmark_fetch', fetchArgs)).toMatchObject({ status: 'partial' });
    expect(subcall).not.toHaveBeenCalled();
  });
});

describe('durable benchmark discovery and free follow-up', () => {
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
    f.operations.set(stableResearchId(discoveryId, '0'), { state });
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
      f.operations.set(key, { state: 'dispatched', executionId: refreshId });
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
