/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { VendorCalls } from '../../research/runtime/subcall';
import type { ResearchToolsConfig } from '../../research/vendors/config';
import type { CounterStore } from '../limiter';
import { NO_DATA_REASON, researchTools, type ResearchToolsInput } from './research';
import { supplierSubcall, type SupplierDeps } from './suppliers';
import { freeSlots, ledger, policy, result } from './__tests__/fixtures';

const config: ResearchToolsConfig = {
  version: 1, enabled: true,
  vendors: { tikhub: { enabled: true, hardCapAttested: null }, parallel: { enabled: true, hardCapAttested: null },
    firecrawl: { enabled: true, hardCapAttested: null } },
  verifiedPlatforms: ['xiaohongshu', 'tiktok'], benchmarkPlatforms: [],
  routes: [
    { platform: 'xiaohongshu', kind: 'keyword_posts', vendor: 'tikhub', route: 'xhs-search', backup: null, maxUnitsPerCall: '1' },
    { platform: 'tiktok', kind: 'account_profile', vendor: 'tikhub', route: 'tt-profile', backup: null, maxUnitsPerCall: '1' },
    { platform: 'tiktok', kind: 'account_posts', vendor: 'tikhub', route: 'tt-posts', backup: null, maxUnitsPerCall: '1' },
    { platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' },
  ],
  limits: { maxSubcallsPerRound: 12, discoverSubcalls: 1 },
  recentGrowth: { maxFirstPostAgeDays: 30, minViewsToFollowers: '1' },
};
const policies = [policy('tikhub', 'xhs-search'), policy('tikhub', 'tt-profile'), policy('tikhub', 'tt-posts'),
  policy('parallel', 'parallel:search:fast', '0.005')];

function vendors(tikhub: VendorCalls['tikhub']): VendorCalls {
  return { tikhub, parallel: vi.fn(async () => result({ vendor: 'parallel', route: 'parallel:search:fast' })),
    firecrawl: vi.fn(async () => { throw new Error('unused'); }) };
}
function setup(tikhub: VendorCalls['tikhub'], over: Partial<ResearchToolsInput> = {}, supplier: Partial<SupplierDeps> = {}) {
  const h = ledger();
  const outcomes: string[] = [];
  const tools = researchTools({ calls: h.deps, config, names: ['social_search', 'social_account', 'web_search'],
    offered: ['social_search', 'social_account', 'web_search'], maxCalls: 3, maxSubcalls: 12,
    suppliers: { keys: { tikhub: 'K', parallel: 'K' }, slots: freeSlots, policies, vendors: vendors(tikhub), ...supplier },
    accounts: { benchmark: [], currentMessage: 'look at https://www.tiktok.com/@someone please' },
    onOutcome: (_n, outcome) => outcomes.push(outcome), ...over });
  const tool = (name: string) => tools.find(t => t.name === name)!;
  return { h, tools, tool, outcomes };
}
const parse = (text: string) => JSON.parse(text) as { status: string; reason: string | null; items: unknown[] };

describe('general research tools on the turn core (CORE-PATH-V2 V2-6)', () => {
  it('social_search: one row for the call, one subcall per keyword, billed from the receipts', async () => {
    const tikhub = vi.fn(async (call: { keyword?: string }) => result({ vendor: 'tikhub', route: 'xhs-search',
      items: [{ fields: { title: call.keyword ?? '' }, missing: [] }] }));
    const s = setup(tikhub);
    const out = parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['a', 'b'], limit: null }, 'c1'));
    expect(out.status).toBe('ok');
    expect(out.items).toHaveLength(2);
    expect(tikhub).toHaveBeenCalledTimes(2);
    expect(s.h.kinds()).toEqual(['begin', 'record:ok']);
    // Bound: 2 keywords x 0.001; n = 2 x 0.001.
    expect(s.h.writes[0]![1]).toMatchObject({ upperUsd: '0.002', multiplier: '6' });
    expect(s.h.writes[1]![1]).toMatchObject({ nominalUsd: '0.002', actualUsd: '0.002' });
  });

  it('every subcall reports its line in the mentor\'s research_call format, with what it settled at', async () => {
    const events: Array<Record<string, unknown>> = [];
    const emit = (event: Record<string, unknown>) => events.push(event);
    const tikhub = vi.fn(async (call: { keyword?: string }) => result({ vendor: 'tikhub', route: 'xhs-search',
      items: call.keyword === 'a' ? [{ fields: { title: 'a' }, missing: [] }] : [] }));
    await setup(tikhub, { onCall: { emit, q: '100' } }).tool('social_search')
      .execute({ platform: 'xiaohongshu', keywords: ['a', 'b'], limit: null }, 'c1');
    expect(events.map(e => [e.query, e.state, e.credits])).toEqual([['a', 'running', undefined], ['a', 'succeeded', '0.6'],
      ['b', 'running', undefined], ['b', 'succeeded', '0']]);
    expect(events[1]).toMatchObject({ type: 'research_call', toolName: 'social_search', platform: 'xiaohongshu', dataKind: 'keyword_posts',
      args: { platform: 'xiaohongshu', keywords: ['a', 'b'] }, callId: events[0]!.callId, evidenceId: events[0]!.callId });
    expect(events[2]!.callId).not.toBe(events[0]!.callId);
  });

  it('research_call: unknown has no amount yet; a refused call or a subcall never sent reports no charge', async () => {
    const events: Array<Record<string, unknown>> = [];
    const onCall = { emit: (event: Record<string, unknown>) => events.push(event), q: '100' };
    await setup(vi.fn(async () => { throw new Error('reset'); }), { onCall }).tool('social_search')
      .execute({ platform: 'xiaohongshu', keywords: ['a'], limit: null }, 'c1');
    expect(events[1]).toMatchObject({ state: 'unknown', credits: null });
    events.length = 0;
    await setup(vi.fn(), { onCall }, { keys: {} }).tool('web_search').execute({ query: 'x', mode: 'fast' }, 'c1');
    expect(events[1]).toMatchObject({ state: 'failed', platform: 'web', dataKind: 'web_search' });
    expect(events[1]).not.toHaveProperty('credits');
    events.length = 0;
    await setup(vi.fn(), { onCall }).tool('social_account').execute({ platform: 'tiktok', account: 'stranger', posts: null }, 'c1');
    expect(events).toEqual([]);
  });

  it('a search that returns nothing is an explicit no-data result the user is not charged for', async () => {
    const s = setup(vi.fn(async () => result({ vendor: 'tikhub', route: 'xhs-search', items: [], reason: 'NO_RESULTS' })));
    const out = parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['冷门词'], limit: null }, 'c1'));
    expect(out).toMatchObject({ status: 'unavailable', reason: NO_DATA_REASON, items: [] });
    expect(s.h.kinds()).toEqual(['begin', 'record:unusable']);
    expect(s.outcomes).toEqual(['no_data']);
  });

  it('an unknown supplier result settles at 0 for the user: no receipt, left for turn_close and recovery', async () => {
    const s = setup(vi.fn(async () => { throw new Error('socket hang up'); }));
    const out = parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['a'], limit: null }, 'c1'));
    expect(out).toMatchObject({ status: 'unavailable', reason: 'PROVIDER_RESULT_UNKNOWN' });
    expect(s.h.kinds()).toEqual(['begin']);
    expect(s.outcomes).toEqual(['unknown']);
  });

  it('social_account only for an account the user named (benchmark table or a profile link in this message)', async () => {
    const tikhub = vi.fn(async (call: { kind: string }) => result({ vendor: 'tikhub', route: call.kind === 'account_posts' ? 'tt-posts' : 'tt-profile' }));
    const s = setup(tikhub);
    const refused = parse(await s.tool('social_account').execute({ platform: 'tiktok', account: 'stranger', posts: null }, 'c1'));
    expect(refused).toMatchObject({ status: 'not_confirmed', reason: 'ACCOUNT_NOT_CONFIRMED' });
    expect(s.h.writes).toEqual([]);
    const ok = parse(await s.tool('social_account').execute({ platform: 'tiktok', account: 'someone', posts: null }, 'c2'));
    expect(ok.status).toBe('ok');
    expect(tikhub).toHaveBeenCalledTimes(2);
    // Bound: the account set's worst case (3 subcalls) at the highest frozen route price.
    expect(s.h.writes[0]![1]).toMatchObject({ upperUsd: '0.003' });
  });

  it('counts calls and subcalls: past either limit nothing is written or sent', async () => {
    const tikhub = vi.fn(async () => result({ vendor: 'tikhub', route: 'xhs-search' }));
    const s = setup(tikhub, { maxSubcalls: 7 });
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: five, limit: null }, 'c1')).status).toBe('ok');
    const over = parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['f', 'g', 'h'], limit: null }, 'c2'));
    expect(over).toMatchObject({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
    expect(tikhub).toHaveBeenCalledTimes(5);
    await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['f'], limit: null }, 'c3');
    await s.tool('web_search').execute({ query: 'x', mode: 'fast' }, 'c4');
    expect(s.tools.every(t => t.enabled?.() === false)).toBe(true);
    const fourth = parse(await s.tool('web_search').execute({ query: 'y', mode: 'fast' }, 'c5'));
    expect(fourth).toMatchObject({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' });
    expect(s.h.kinds().filter(k => k === 'begin')).toHaveLength(3);
  });

  it('a tool trimmed this turn keeps its definition but answers unavailable without a write', async () => {
    const s = setup(vi.fn(), { names: ['web_search'] });
    const out = parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['a'], limit: null }, 'c1'));
    expect(out).toMatchObject({ status: 'unavailable', reason: 'TOOL_UNAVAILABLE_THIS_TURN' });
    expect(s.tools.map(t => t.name)).toEqual(['social_search', 'social_account', 'web_search']);
    expect(s.h.writes).toEqual([]);
  });

  it('invalid arguments and unsupported platforms send nothing', async () => {
    const s = setup(vi.fn());
    expect(parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: [], limit: null }, 'c1')).reason)
      .toBe('INVALID_ARGUMENTS');
    expect(parse(await s.tool('social_search').execute({ platform: 'douyin', keywords: ['a'], limit: null }, 'c2')).status)
      .toBe('not_supported');
    expect(s.h.writes).toEqual([]);
  });
});

describe('one supplier subcall (3.3.2 item 10: per-supplier in-flight limit with backoff)', () => {
  const request = { vendor: 'tikhub' as const, route: 'xhs-search', call: { platform: 'xiaohongshu' as const, kind: 'keyword_posts' as const,
    keyword: 'a', limit: 20 } };
  const base = (over: Partial<SupplierDeps> = {}): SupplierDeps => ({ keys: { tikhub: 'K' }, slots: freeSlots, policies,
    vendors: vendors(vi.fn(async () => result({ vendor: 'tikhub', route: 'xhs-search' }))), sleep: async () => {}, ...over });

  it('all slots busy: waits with backoff, then gives up unsent and free', async () => {
    let now = 0;
    const busy: CounterStore = { take: async () => 99, drop: async () => undefined };
    const waits: number[] = [];
    const out = await supplierSubcall(base({ slots: busy, clock: () => now, sleep: async ms => { waits.push(ms); now += ms; } }), request);
    expect(out).toMatchObject({ costUsd: '0', result: { outcome: 'not_sent', reason: 'VENDOR_BUSY' } });
    expect(waits.slice(0, 3)).toEqual([100, 200, 400]);
  });

  it('the counter unreachable: fails closed, unsent', async () => {
    const down: CounterStore = { take: async () => { throw new Error('down'); }, drop: async () => undefined };
    expect((await supplierSubcall(base({ slots: down }), request)).result.reason).toBe('VENDOR_LIMIT_UNAVAILABLE');
  });

  it('no key, no frozen price, or too little time left: nothing is sent', async () => {
    expect((await supplierSubcall(base({ keys: {} }), request)).result.reason).toBe('KEY_MISSING');
    expect((await supplierSubcall(base({ policies: [] }), request)).result.reason).toBe('ROUTE_NOT_FROZEN');
    expect((await supplierSubcall(base({ timeLeft: () => 5_000 }), request)).result.reason).toBe('TIME_LEFT_TOO_SHORT');
  });

  it('priced from official usage at the frozen price; a sent request that throws is unknown and never resent', async () => {
    expect(await supplierSubcall(base(), request)).toMatchObject({ costUsd: '0.001', multiplier: '6' });
    const tikhub = vi.fn(async () => { throw new Error('reset'); });
    const out = await supplierSubcall(base({ vendors: vendors(tikhub) }), request);
    expect(out).toMatchObject({ costUsd: null, result: { outcome: 'unknown' } });
    expect(tikhub).toHaveBeenCalledTimes(1);
  });
});

describe('the bound of a call covers requests it may add (YouTube post detail)', () => {
  it('prices every subcall at the dearest route the call may reach, the detail route included', async () => {
    const route = (kind: 'account_posts' | 'post_detail', name: string) =>
      ({ platform: 'youtube' as const, kind, vendor: 'tikhub' as const, route: name, backup: null, maxUnitsPerCall: '1' as const });
    const yt = { ...config, verifiedPlatforms: ['youtube' as const], routes: [route('account_posts', 'yt-posts'), route('post_detail', 'yt-detail')] };
    const tikhub = vi.fn(async (call: { kind: string }) => result({ vendor: 'tikhub',
      route: call.kind === 'post_detail' ? 'yt-detail' : 'yt-posts', items: [{ fields: { id: 'v1' }, missing: [] }] }));
    const s = setup(tikhub, { config: yt, accounts: { benchmark: [], currentMessage: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv' } },
      { policies: [policy('tikhub', 'yt-posts', '0.001'), policy('tikhub', 'yt-detail', '0.1', '9')] });
    const out = JSON.parse(await s.tool('social_account').execute({ platform: 'youtube', account: 'UCabcdefghijklmnopqrstuv', posts: null }, 'c1'));
    expect(out.status).toBe('ok');
    expect(tikhub).toHaveBeenCalledTimes(2);
    // 3 subcalls x 0.1 (the detail route), at the detail route's m 9.
    expect(s.h.writes[0]![1]).toMatchObject({ upperUsd: '0.3', multiplier: '9' });
  });
});

describe('a supplier answer cut short stays partial', () => {
  it('keeps the supplier\'s partial and truncated marks in the tool result', async () => {
    const s = setup(vi.fn(async () => result({ vendor: 'tikhub', route: 'xhs-search', outcome: 'partial', reason: 'ITEM_LIMIT', truncated: true })));
    const out = JSON.parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['a'], limit: null }, 'c1'));
    expect(out).toMatchObject({ status: 'partial', reason: 'ITEM_LIMIT', truncated: true });
    expect(s.h.kinds()).toEqual(['begin', 'record:ok']);
  });
});

describe('refs are unique across the research calls of a turn', () => {
  it('numbers each call, then each subcall and item', async () => {
    const s = setup(vi.fn(async () => result({ vendor: 'tikhub', route: 'xhs-search' })));
    const first = JSON.parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['a', 'b'], limit: null }, 'c1'));
    const second = JSON.parse(await s.tool('social_search').execute({ platform: 'xiaohongshu', keywords: ['c'], limit: null }, 'c2'));
    const refs = [...first.items, ...second.items].map((item: { fields: { ref: string } }) => item.fields.ref);
    expect(refs).toEqual(['c1s1#1', 'c1s2#1', 'c2s1#1']);
  });
});
