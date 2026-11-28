/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Owner 2026-11-28 (H, I; pay4's Douyin run): an account whose posts plainly make other content than the confirmed niche does not
// qualify, and the coach gets the account's name and newest titles to judge it by.
import { describe, expect, it, vi } from 'vitest';
import type { ToolCallPolicy } from '../../turn/provider/toolBilling';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../vendors/config';
import { tikhubRouteId } from '../vendors/tikhub';
import type { ResearchCallResult } from '../vendors/types';
import { benchmarkFetch, FETCH_JUDGE_NEXT_STEP } from './benchmarkFetch';
import type { FetchClaim, RuntimeResearchStore } from './store';
import type { EvidencePort, ToolSubcallBilling } from './subcall';
import type { ResearchToolContext } from './toolContext';

const id = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-11-28T05:00:00.000Z');
const kinds = ['account_profile', 'account_posts'] as const;
/** The keywords pay4 confirmed (seq 25). */
export const PAY4_KEYWORDS = ['杭州皮具手作', '皮具体验课', '杭州手作体验', '皮革DIY', '手工卡包', '闺蜜手作', '周末手作', '杭州周末去哪玩'];
/** 云朵泡芙's newest titles in that run: dessert boxes for friends, never leather. */
const DESSERTS = ['🍏青苹果布丁船&芭菲杯｜清透治愈，一眼降温 #治愈美食diy', '沉浸式给闺蜜做漂亮甜品丨青苹果甜品便当局 #手作甜品治愈系',
  '冬日甜份送达，闺蜜一眼心动的抹茶树莓便当 #下午茶diy', '圣诞限定甜品便当｜打包冬日浪漫送给好搭子 #圣诞甜品diy'];
const LEATHER = ['手工皮具卡包制作教程 #手工皮艺 #手缝教程', '纯手工皮具 水桶包 #手工皮革 #手作爱好者', '皮具体验课 周末带朋友来做卡包'];

function fixture(input: { name: string; titles: string[]; source?: 'candidate' | 'user_message' | 'refresh';
  /** The keywords of the round whose candidate card was confirmed (a store without the record: undefined). */
  round?: string[]; prior?: Record<string, unknown> | null }) {
  const account = { platform: 'douyin', account: 'MS4wLjABAAAA' + 'a'.repeat(40) } as const;
  const source = input.source === 'user_message' ? { kind: 'user_message' as const, messageId: id }
    : input.source === 'refresh' ? { kind: 'refresh' as const, refreshId: id } : { kind: 'candidate' as const, confirmationId: id };
  const vendor = { enabled: true, hardCapAttested: { by: id, at: now.toISOString() } };
  const config = researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor }, verifiedPlatforms: ['douyin'], benchmarkPlatforms: ['douyin'],
    routes: kinds.map(kind => ({ platform: 'douyin', kind, vendor: 'tikhub', route: tikhubRouteId('douyin', kind), backup: null,
      maxUnitsPerCall: '1' })) });
  const policies: ToolCallPolicy[] = kinds.map(kind => ({ provider: 'tikhub', account: 'tikhub-main',
    model: `tikhub:${tikhubRouteId('douyin', kind)}`, protocol: 'research-tool-v1', modelId: id, multiplier: '6', lookupSupported: false,
    upperUsd: '0.01', purposes: ['question'], toolPricing: { unit: 'call', currency: 'USD', price: '0.01', unitsPerPrice: '1',
      usdPerCurrency: null, entryHash: 'a'.repeat(64), validUntil: '2026-12-31T00:00:00Z', maxUnitsPerCall: '1' } }));
  const operations = new Map<string, { state: string; result?: unknown }>();
  const evidence: EvidencePort = {
    open: vi.fn(async operationId => { operations.set(operationId, { state: 'prepared' }); return { token: 'token' }; }),
    dispatch: vi.fn(async operationId => { operations.set(operationId, { state: 'dispatched' }); return true; }),
    finish: vi.fn(async (operationId, _token, state, result) => { operations.set(operationId, { state, result }); }),
    cancel: vi.fn(async () => undefined), link: vi.fn(async () => undefined),
  };
  const fetchFinish = vi.fn<RuntimeResearchStore['fetchFinish']>(async () => undefined);
  const store = { authorization: { candidateConfirmation: vi.fn().mockResolvedValue([account]),
    userMessage: vi.fn(async () => `https://www.douyin.com/user/${account.account}`),
    refreshGrant: vi.fn(async () => ({ ...account, used: false })) },
  ...(input.round ? { roundKeywords: async () => input.round } : {}),
  priorEvidence: async () => input.prior ?? null,
  evidence: () => evidence, fetchClaim: vi.fn(async (): Promise<FetchClaim> => ({ claimed: true, fetchId: id, attempt: 'attempt-1' })),
  fetchDispatch: vi.fn(async () => true), fetchFinish, fetchResume: vi.fn(async () => null),
  readOperation: vi.fn(async (operationId: string) => operations.get(operationId) ?? null), callCharge: vi.fn().mockResolvedValue(null),
  sessionKeywords: async () => PAY4_KEYWORDS, offerShortfall: async () => null } as unknown as RuntimeResearchStore;
  const billing: ToolSubcallBilling = { runId: id,
    claim: vi.fn(async () => ({ state: 'claimed' as const, callId: 'call-1', token: 'token' })), dispatch: vi.fn(async () => true),
    record: vi.fn(async () => ({ accountClosed: false, contentDeleted: false })) };
  // 21 posts within the last 30 days, the titles repeated in turn; Douyin gives likes but no views.
  const tikhub = vi.fn(async (call: { kind: string }): Promise<ResearchCallResult> => ({ vendor: 'tikhub',
    route: tikhubRouteId('douyin', call.kind as 'account_posts')!, outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
    usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: now.toISOString(),
    items: call.kind === 'account_profile' ? [{ fields: { name: input.name, followers: 81186, postsCount: 21 }, missing: [] }]
      : Array.from({ length: 21 }, (_, i) => ({ fields: { id: `p${i}`, title: input.titles[i % input.titles.length]!,
        publishedAt: new Date(now.getTime() - i * 86_400_000).toISOString(), likes: 100, comments: 20, shares: 5 }, missing: [] })) }));
  const ctx: ResearchToolContext = { scope: { userId: id, sessionId: id }, executionId: id, config, store, emit: vi.fn(), now: () => now,
    subcall: { policies, billing, evidence, nextSequence: () => 1, phase: 'question', secrets: async () => 'test-key',
      rateCounter: async () => true, newId: () => id, now: () => now, vendors: { tikhub, parallel: vi.fn(), firecrawl: vi.fn() } } };
  const run = async () => JSON.parse(await benchmarkFetch(ctx, { accounts: [account], source }, { left: 10, used: 0 }));
  const saved = () => fetchFinish.mock.calls.at(-1)![3] as { classification: { qualified: boolean; excluded: string | null };
    relevanceBasis: unknown };
  return { run, saved };
}

describe('benchmark_fetch judges the account against the confirmed niche (Owner 2026-11-28, H)', () => {
  it('pay4: a dessert account with the numbers of a benchmark does not qualify (OFF_TOPIC)', async () => {
    const f = fixture({ name: '云朵泡芙', titles: DESSERTS });
    const result = await f.run();
    expect(f.saved().classification).toEqual({ category: null, qualified: false, excluded: 'OFF_TOPIC' });
    // The coach is told the account was judged off topic and gets its name and titles (I).
    const fields = result.items[0].fields;
    expect(JSON.parse(fields.evidence).classification.excluded).toBe('OFF_TOPIC');
    expect(fields.name).toBe('云朵泡芙');
    expect(fields.recentTitles.split(' ｜ ')).toHaveLength(4);
    expect(result.nextStep).toBe(FETCH_JUDGE_NEXT_STEP);
  });

  it('a leather crafter with the same numbers qualifies', async () => {
    const f = fixture({ name: '小熊猫工作室', titles: LEATHER });
    await f.run();
    expect(f.saved().classification).toMatchObject({ qualified: true, excluded: null });
  });

  it('an account whose name names the niche is on topic, and a link the user sent is judged on its numbers only', async () => {
    const named = fixture({ name: '无它手工皮具', titles: DESSERTS });
    await named.run();
    expect(named.saved().classification).toMatchObject({ qualified: true });
    const pasted = fixture({ name: '云朵泡芙', titles: DESSERTS, source: 'user_message' });
    await pasted.run();
    expect(pasted.saved().classification).toMatchObject({ qualified: true });
  });

  // Review of #2063: a candidate is judged by the keywords of the round that found it.
  it('a search with another set of keywords judges its candidates by them, not by the earlier round\'s', async () => {
    // The first round's 杭州皮具手作/皮具体验课 alone give 皮具; this round searched 皮革DIY/皮革钱包, whose niche is 皮革.
    const titles = ['手缝皮革钱包 #皮革DIY', '皮革卡包打磨过程', '植鞣皮革零钱包'];
    const round = fixture({ name: '某工作室', titles, round: ['皮革DIY', '皮革钱包'] });
    await round.run();
    expect(round.saved().classification).toMatchObject({ qualified: true, excluded: null });
    expect(round.saved().relevanceBasis).toEqual({ kind: 'keywords', keywords: ['皮革DIY', '皮革钱包'] });
    // The session's keywords merged (the old reading) would have found 皮具 only and excluded it.
    const merged = fixture({ name: '某工作室', titles });
    await merged.run();
    expect(merged.saved().classification).toMatchObject({ excluded: 'OFF_TOPIC' });
  });

  // Review of #2063: the exemption of an account the user sent follows the account, not this call.
  it('a link the user sent and then refreshed stays judged on its numbers only', async () => {
    const pasted = fixture({ name: '云朵泡芙', titles: DESSERTS, source: 'user_message' });
    await pasted.run();
    expect(pasted.saved().relevanceBasis).toEqual({ kind: 'user_pick' });
    const refreshed = fixture({ name: '云朵泡芙', titles: DESSERTS, source: 'refresh', prior: pasted.saved() as Record<string, unknown> });
    await refreshed.run();
    expect(refreshed.saved().classification).toMatchObject({ qualified: true, excluded: null });
    expect(refreshed.saved().relevanceBasis).toEqual({ kind: 'user_pick' });
    // A refreshed candidate keeps its round's keywords; an account fetched before the rule is not newly judged.
    const candidate = fixture({ name: '云朵泡芙', titles: DESSERTS, round: PAY4_KEYWORDS });
    await candidate.run();
    const again = fixture({ name: '云朵泡芙', titles: DESSERTS, source: 'refresh', prior: candidate.saved() as Record<string, unknown> });
    await again.run();
    expect(again.saved().classification).toMatchObject({ excluded: 'OFF_TOPIC' });
    const older = fixture({ name: '云朵泡芙', titles: DESSERTS, source: 'refresh', prior: { classification: { qualified: true } } });
    await older.run();
    expect(older.saved()).toMatchObject({ classification: { qualified: true }, relevanceBasis: { kind: 'unjudged' } });
  });
});
