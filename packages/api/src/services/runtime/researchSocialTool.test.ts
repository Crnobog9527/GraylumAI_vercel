/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT C: the free chat research tools (social_search, social_account, the per-reply call limit and the
// subcall allowance that survives a pause or restart). Supplier requests are the mocked runSubcall.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchRuntimeTools, researchToolDescription } from './researchRuntimeTool';
import { requestIdentity, runSubcall, type SubcallContext, type SupplierRequest } from '../research/runtime/subcall';
import type { ResearchToolContext } from '../research/runtime/toolContext';
import type { RuntimeOperation, RuntimeResearchStore } from '../research/runtime/store';
import type { ToolEnvelope } from '../research/tools/envelope';
import { GENERAL_RESEARCH_TOOLS } from '../research/tools/names';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../research/vendors/config';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { FIRECRAWL_ROUTE } from '../research/vendors/firecrawl';
import type { AccountSources } from './researchSocialTool';

vi.mock('../research/runtime/subcall', async importOriginal => ({
  ...await importOriginal<typeof import('../research/runtime/subcall')>(), runSubcall: vi.fn(),
}));
const subcall = vi.mocked(runSubcall);
const id = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-23T00:00:00Z');

function config(limit = 12) {
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  return researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: ['tiktok', 'douyin'], benchmarkPlatforms: [],
    limits: { maxSubcallsPerRound: limit, discoverSubcalls: 1 },
    routes: [
      ...(['tiktok', 'douyin'] as const).flatMap(platform => (['keyword_posts', 'account_profile', 'account_posts'] as const)
        .map(kind => ({ platform, kind, vendor: 'tikhub', route: tikhubRouteId(platform, kind), backup: null, maxUnitsPerCall: '1' }))),
      { platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' },
      { platform: 'web', kind: 'web_fetch', vendor: 'firecrawl', route: FIRECRAWL_ROUTE, backup: null, maxUnitsPerCall: '1' },
    ],
  });
}

function fixture(options: { limit?: number; used?: number; benchmark?: string[]; message?: string | null } = {}) {
  const operations = new Map<string, RuntimeOperation>();
  const sent: SupplierRequest[] = [];
  const store = {
    readOperation: vi.fn(async (key: string) => operations.get(key) ?? null),
    evidence: vi.fn(() => ({})), callCharge: vi.fn().mockResolvedValue('0.6'),
  } as unknown as RuntimeResearchStore;
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config: config(options.limit), store,
    subcall: { policies: [], billing: { runId: id, claim: vi.fn(), dispatch: vi.fn(), record: vi.fn() }, evidence: {},
      nextSequence: vi.fn(), phase: 'research', secrets: vi.fn(), rateCounter: vi.fn(), newId: vi.fn() } as unknown as SubcallContext,
    emit: vi.fn(), now: () => now };
  subcall.mockImplementation(async (context, request) => {
    const operationId = context.newId();
    sent.push(request);
    const items = [{ fields: { id: 'post-1', views: 1000 }, missing: [] }];
    operations.set(operationId, { state: 'succeeded', identityHash: requestIdentity(request),
      result: { items, outcome: 'ok', reason: null, fetchedAt: now.toISOString(), truncated: false } });
    return { sent: true, operationId, callId: id, result: { vendor: request.vendor, route: request.route, outcome: 'ok',
      reason: null, httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items, truncated: false,
      fetchedAt: now.toISOString() } };
  });
  const accounts: AccountSources = {
    benchmarkAccounts: vi.fn(async () => (options.benchmark ?? []).map(account => ({ platform: 'tiktok' as const, account }))),
    currentMessage: vi.fn(async () => options.message ?? null),
  };
  const usedSubcalls = vi.fn(async () => options.used ?? 0);
  const tools = researchRuntimeTools(ctx, GENERAL_RESEARCH_TOOLS, { freeChat: { accounts }, usedSubcalls });
  const execute = async (name: string, args: Record<string, unknown>, callId = 'call-1') =>
    JSON.parse(await tools.find(tool => tool.name === name)!.execute(args, callId)) as ToolEnvelope;
  return { ctx, operations, sent, accounts, usedSubcalls, tools, execute };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('free chat research tools', () => {
  it('offers the four general tools with the free chat limit in their descriptions', () => {
    const f = fixture();
    expect(f.tools.map(tool => tool.name)).toEqual(['social_search', 'social_account', 'web_search', 'web_fetch']);
    expect(researchToolDescription('web_search', true)).toContain('At most 3 research tool calls per reply');
    expect(researchToolDescription('web_search')).toContain('At most one research tool call per reply');
    expect(researchToolDescription('social_account', true)).toContain("user's benchmark table");
  });

  it('social_search sends one keyword_posts subcall per keyword and labels every item', async () => {
    const f = fixture();
    const result = await f.execute('social_search', { platform: 'tiktok', keywords: ['美食', '探店'] });
    expect(result.status).toBe('ok');
    expect(f.sent.map(request => request.vendor === 'tikhub' && [request.call.kind, request.call.keyword]))
      .toEqual([['keyword_posts', '美食'], ['keyword_posts', '探店']]);
    expect(result.items.map(item => item.fields.keyword)).toEqual(['美食', '探店']);
    expect(result.items.every(item => String(item.fields.ref).includes('#'))).toBe(true);
  });

  it('social_search on an unverified platform is not supported and sends nothing', async () => {
    const f = fixture();
    expect(await f.execute('social_search', { platform: 'bilibili', keywords: ['x'] })).toMatchObject({ status: 'not_supported' });
    expect(f.sent).toHaveLength(0);
  });

  it('social_account refuses an account that is neither a benchmark nor linked in this message', async () => {
    const f = fixture({ benchmark: ['alice'], message: 'look at https://www.tiktok.com/@carol' });
    expect(await f.execute('social_account', { platform: 'tiktok', account: 'mallory' }))
      .toMatchObject({ status: 'not_confirmed', reason: 'ACCOUNT_NOT_CONFIRMED' });
    expect(f.sent).toHaveLength(0);
    expect(subcall).not.toHaveBeenCalled();
  });

  it.each([
    ['a benchmark account', { benchmark: ['alice'] }, 'alice'],
    ['a profile linked in the message being answered', { message: '帮我看看 https://www.tiktok.com/@carol 最近发了什么' }, 'carol'],
  ])('social_account looks up %s: profile then posts', async (_case, options, account) => {
    const f = fixture(options);
    const result = await f.execute('social_account', { platform: 'tiktok', account });
    expect(result.status).toBe('ok');
    expect(f.sent.map(request => request.vendor === 'tikhub' && request.call.kind)).toEqual(['account_profile', 'account_posts']);
    expect(result.items.every(item => item.fields.account === account)).toBe(true);
  });

  it('a fourth research call in one reply is refused without contacting a supplier', async () => {
    const f = fixture();
    for (const callId of ['a', 'b', 'c']) await f.execute('web_search', { query: 'topic ' + callId }, callId);
    expect(f.sent).toHaveLength(3);
    expect(await f.execute('web_fetch', { url: 'https://example.com' }, 'd'))
      .toMatchObject({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' });
    expect(f.sent).toHaveLength(3);
  });

  it('keeps the round allowance across a resume: 8 subcalls already saved leave 4, a 5-keyword search is refused whole', async () => {
    const f = fixture({ used: 8 });
    const refused = await f.execute('social_search', { platform: 'tiktok', keywords: ['a', 'b', 'c', 'd', 'e'] });
    expect(refused).toMatchObject({ status: 'budget_exhausted' });
    expect(f.sent).toHaveLength(0);
    expect(await f.execute('social_search', { platform: 'tiktok', keywords: ['a', 'b', 'c', 'd'] }, 'call-2'))
      .toMatchObject({ status: 'ok' });
    expect(f.sent).toHaveLength(4);
    expect(f.usedSubcalls).toHaveBeenCalledTimes(1);
  });

  it('three rounds of five keywords never exceed twelve subcalls', async () => {
    const f = fixture();
    const keywords = ['a', 'b', 'c', 'd', 'e'];
    expect(await f.execute('social_search', { platform: 'tiktok', keywords }, 'r1')).toMatchObject({ status: 'ok' });
    expect(await f.execute('social_search', { platform: 'douyin', keywords }, 'r2')).toMatchObject({ status: 'ok' });
    expect(await f.execute('social_search', { platform: 'tiktok', keywords: ['f', 'g', 'h', 'i', 'j'] }, 'r3'))
      .toMatchObject({ status: 'budget_exhausted' });
    expect(f.sent).toHaveLength(10);
  });

  it('a resumed answer reads its saved subcalls instead of sending (and paying) again', async () => {
    const first = fixture();
    await first.execute('social_search', { platform: 'tiktok', keywords: ['美食'] });
    expect(first.sent).toHaveLength(1);
    // Same answer and tool call after a restart: the operations are saved, the allowance already counts them.
    const resumed = fixture({ used: 12 });
    for (const [key, value] of first.operations) resumed.operations.set(key, value);
    const replay = await resumed.execute('social_search', { platform: 'tiktok', keywords: ['美食'] });
    expect(replay.status).toBe('ok');
    expect(replay.items).toHaveLength(1);
    expect(resumed.sent).toHaveLength(0);
  });

  it('a saved operation whose request differs is never answered from', async () => {
    const first = fixture();
    await first.execute('social_search', { platform: 'tiktok', keywords: ['美食'] });
    const other = fixture();
    for (const [key, value] of first.operations) other.operations.set(key, value);
    expect(await other.execute('social_search', { platform: 'tiktok', keywords: ['探店'] }))
      .toMatchObject({ status: 'unavailable', reason: 'OPERATION_IDENTITY_MISMATCH' });
    expect(other.sent).toHaveLength(0);
  });
});
