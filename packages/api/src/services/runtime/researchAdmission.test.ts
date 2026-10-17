/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admitResearchTurn, attachResearchTurn, researchToolBytes } from './researchAdmission';
import { frozenResearchConfig, PRODUCTION_RESEARCH_ACCOUNT, RESEARCH_PHASE } from './researchTurn';
import { runtimeContext } from './runtimeContext';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema, selectRoute } from '../research/vendors/config';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { FIRECRAWL_ROUTE } from '../research/vendors/firecrawl';
import { toolModelId } from '../bill2/toolBilling';
import type { FrozenPaygRun } from '../bill2/service';
import type { StagingPolicy } from './stagingPolicy';

const admin = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-17T00:00:00Z');
const day = 86_400_000;
const deadline = new Date(now.getTime() + 3_600_000).toISOString();
const tiktok = (kind: 'keyword_posts' | 'account_profile' | 'account_posts') => tikhubRouteId('tiktok', kind)!;
const tiktokRoutes = (['keyword_posts', 'account_profile', 'account_posts'] as const).map(kind => ({
  platform: 'tiktok', kind, vendor: 'tikhub', route: tiktok(kind), backup: null, maxUnitsPerCall: '1' }));
const webRoutes = [
  { platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' },
  { platform: 'web', kind: 'web_fetch', vendor: 'firecrawl', route: FIRECRAWL_ROUTE, backup: null, maxUnitsPerCall: '1' },
];

function config(patch: Record<string, unknown> = {}) {
  const vendor = { enabled: true, hardCapAttested: { by: admin, at: now.toISOString() } };
  return researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
    vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor },
    verifiedPlatforms: ['tiktok'], benchmarkPlatforms: ['tiktok'], routes: [...tiktokRoutes, ...webRoutes],
    limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 }, ...patch });
}
const entry = (provider: string, route: string | null, usageUnit: string, validUntil = new Date(now.getTime() + 7 * day).toISOString()) => ({
  provider, route, appliesToUnlistedRoutes: route === null, currency: 'USD', usageUnit, unitsPerPrice: '1', price: '0.01',
  usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null, pricingBasis: 'official list',
  sourceUrl: 'https://example.com/pricing', evidenceHash: 'a'.repeat(64), verifiedAt: new Date(now.getTime() - day).toISOString(),
  validUntil, chargeCondition: 'per call', includedInReceipt: false, priceMultiplier: null });
const allPrices = () => ({ version: 1, entries: [entry('tikhub', null, 'call'), entry('parallel', 'parallel:search:fast', 'sku_search'),
  entry('firecrawl', FIRECRAWL_ROUTE, 'credit')] });
const allThresholds = () => [...tiktokRoutes, ...webRoutes].map(route => ({ model: `${route.vendor}:${route.route}`, purpose: RESEARCH_PHASE, credits: 1 }));

function database(settings: { config?: unknown; prices?: unknown; thresholds?: unknown[] }): SupabaseClient {
  const values: Record<string, unknown> = {
    research_tools_config: settings.config === undefined ? undefined
      : { ...(settings.config as object), revision: 4, updatedBy: admin, updatedAt: now.toISOString() },
    billing_provider_prices: settings.prices,
    billing_payg_start_thresholds: settings.thresholds ? { version: 'v1', thresholds: settings.thresholds } : undefined,
  };
  return { from: () => ({ select: () => ({ eq: (_column: string, key: string) => ({ maybeSingle: async () => ({ error: null,
    data: values[key] === undefined ? null : { value: values[key], revision: key === 'research_tools_config' ? '4' : undefined } }) }) }) }) } as unknown as SupabaseClient;
}
const input = (db: SupabaseClient, patch: Record<string, unknown> = {}) => ({ admin: db, modelCalls: 3, offeredTools: 3, maxTools: 9,
  defaultMultiplier: '6', runMultiplier: '6', deadline, fits: () => true, now: () => now, ...patch });
const full = () => database({ config: config(), prices: allPrices(), thresholds: allThresholds() });

describe('admitResearchTurn (RT-3b PR-3)', () => {
  it('offers nothing while the admin switch is off, whatever is priced', async () => {
    expect(await admitResearchTurn(input(database({ config: { ...config(), enabled: false }, prices: allPrices(),
      thresholds: allThresholds() })))).toBeNull();
    expect(await admitResearchTurn(input(database({ prices: allPrices(), thresholds: allThresholds() })))).toBeNull();
  });

  it('offers the positioning tools whose routes are priced, with one frozen price each', async () => {
    const admitted = (await admitResearchTurn(input(full())))!;
    expect(admitted.tools).toEqual(['propose_keywords', 'benchmark_discover', 'propose_more_candidates', 'benchmark_fetch', 'web_search', 'web_fetch']);
    expect(admitted.policies.map(p => p.model).sort()).toEqual([...tiktokRoutes, ...webRoutes].map(r => `${r.vendor}:${r.route}`).sort());
    for (const policy of admitted.policies) {
      expect(policy).toMatchObject({ protocol: 'research-tool-v1', account: 'research-local', purposes: [RESEARCH_PHASE],
        modelId: toolModelId(policy.model), multiplier: '6' });
    }
    // 32 − (3 model calls + the one that reads the result) = 28, capped by the configured round limit.
    expect(admitted.research).toMatchObject({ subcalls: 12, discoverSubcalls: 12, configRevision: 4, phase: RESEARCH_PHASE,
      benchmarkPlatforms: ['tiktok'], vendors: ['tikhub', 'parallel', 'firecrawl'] });
    // The admin's attestation stays in settings; the execution config is rebuilt from the frozen routes.
    expect(JSON.stringify(admitted.research)).not.toContain(admin);
    const executionConfig = frozenResearchConfig(admitted.research);
    expect(selectRoute(executionConfig, 'tiktok', 'account_posts', 'benchmark')).toMatchObject({ ok: true, route: tiktok('account_posts') });
  });

  it('drops routes without a current price, a long enough expiry, a start threshold or a fitting multiplier', async () => {
    const shortPrice = { version: 1, entries: [entry('tikhub', null, 'call', new Date(now.getTime() + 60_000).toISOString()),
      entry('parallel', 'parallel:search:fast', 'sku_search'), entry('firecrawl', FIRECRAWL_ROUTE, 'credit')] };
    const noBenchmark = (await admitResearchTurn(input(database({ config: config(), prices: shortPrice, thresholds: allThresholds() }))))!;
    expect(noBenchmark.tools).toEqual(['web_search', 'web_fetch']);
    const noFetchThreshold = (await admitResearchTurn(input(database({ config: config(), prices: allPrices(),
      thresholds: allThresholds().filter(t => !t.model.startsWith('firecrawl:')) }))))!;
    expect(noFetchThreshold.tools).not.toContain('web_fetch');
    // Without keyword search the discovery tools stay off, but a confirmed account can still be fetched.
    const fetchOnly = (await admitResearchTurn(input(database({ config: config(), prices: allPrices(),
      thresholds: allThresholds().filter(t => t.model !== `tikhub:${tiktok('keyword_posts')}`) }))))!;
    expect(fetchOnly.tools).toEqual(['benchmark_fetch', 'web_search', 'web_fetch']);
    expect(await admitResearchTurn(input(full(), { runMultiplier: '3' }))).toBeNull();
    expect(await admitResearchTurn(input(database({ config: config(), prices: allPrices() })))).toBeNull();
  });

  it('is all or nothing: no room for the tool set, no input capacity, or no subcall left means no research', async () => {
    expect(await admitResearchTurn(input(full(), { offeredTools: 4 }))).toBeNull();
    expect(await admitResearchTurn(input(full(), { fits: () => false }))).toBeNull();
    expect(await admitResearchTurn(input(full(), { modelCalls: 31 }))).toBeNull();
    let asked = 0;
    await admitResearchTurn(input(full(), { fits: (bytes: number) => { asked = bytes; return true; } }));
    expect(asked).toBe(researchToolBytes(['propose_keywords', 'benchmark_discover', 'propose_more_candidates',
      'benchmark_fetch', 'web_search', 'web_fetch'], true) + 24576);
  });

  it('on staging uses only tool prices the test window approved exactly', async () => {
    const local = (await admitResearchTurn(input(full())))!;
    const window = (account: string, policies = local.policies) => ({ id: admin, creditsPerUsd: '100', multiplier: '6',
      expiresAt: deadline, callPolicies: [], toolPolicies: policies.map(p => ({ ...p, account })) }) as unknown as StagingPolicy;
    const real = (await admitResearchTurn(input(full(), { real: window('tikhub-staging') })))!;
    expect(real.policies.every(p => p.account === 'tikhub-staging')).toBe(true);
    const stale = local.policies.map(p => p.provider === 'parallel' ? { ...p, upperUsd: '0.02' } : p);
    expect((await admitResearchTurn(input(full(), { real: window('tikhub-staging', stale) })))!.tools).not.toContain('web_search');
    expect(await admitResearchTurn(input(full(), { real: window('x', []) }))).toBeNull();
  });

  it('RUNTIME-PROD: production prices tool routes from the approved configuration alone, with the production account', async () => {
    const local = (await admitResearchTurn(input(full())))!;
    const production = { mode: 'production', id: 'prod-v1', creditsPerUsd: '100', multiplier: '6', expiresAt: deadline,
      callPolicies: [] } as unknown as StagingPolicy;
    const real = (await admitResearchTurn(input(full(), { real: production })))!;
    expect(real.tools).toEqual(local.tools);
    expect(real.policies).toEqual(local.policies.map(p => ({ ...p, account: PRODUCTION_RESEARCH_ACCOUNT })));
    // The same switches still decide: a vendor that is off (no attested hard cap) offers nothing on production either.
    const off = database({ config: config({ vendors: { ...config().vendors, parallel: { enabled: false, hardCapAttested: null } } }),
      prices: allPrices(), thresholds: allThresholds() });
    expect((await admitResearchTurn(input(off, { real: production })))!.tools).not.toContain('web_search');
    expect(await admitResearchTurn(input(database({ config: config(), prices: { version: 1, entries: [] }, thresholds: allThresholds() }),
      { real: production }))).toBeNull();
  });

  it('RUNTIME-PROD: a route multiplier above the models\' is kept on production (the run multiplier follows it)', async () => {
    const production = { mode: 'production', id: 'prod-v1', creditsPerUsd: '100', multiplier: '6', expiresAt: deadline,
      callPolicies: [] } as unknown as StagingPolicy;
    const prices = allPrices();
    prices.entries[0] = { ...prices.entries[0]!, priceMultiplier: '8' } as never;
    const db = database({ config: config(), prices, thresholds: allThresholds() });
    expect((await admitResearchTurn(input(db)))!.tools).not.toContain('benchmark_fetch');
    const real = (await admitResearchTurn(input(db, { real: production })))!;
    expect(real.tools).toContain('benchmark_fetch');
    expect(real.policies.filter(p => p.provider === 'tikhub').every(p => p.multiplier === '8')).toBe(true);
  });
});

describe('attachResearchTurn', () => {
  const primary = '22222222-2222-4222-8222-222222222222';
  function run(maxMessages = 128, maxTools = 9) {
    return { contractVersion: 'bill2.v2', callPolicy: [{ modelId: primary, model: 'vendor/model', upperUsd: '0.05',
      payg: { maxTools, maxMessages } }], rules: { multiplier: '6', billingUnit: { defaultMultiplier: '6' } },
      limits: { maxCalls: 3, costUsd: '0.150000000000', deadline } } as unknown as FrozenPaygRun;
  }
  const mentor = () => ({ modelId: primary, tools: ['ask_question', 'read_skill_file'], maxTurns: 2, maxToolCalls: 1, historyItems: 100 }
  ) as Parameters<typeof attachResearchTurn>[0]['context'];

  it('adds the tools, one reply call, the subcall allowance and the frozen prices to the turn and its run', async () => {
    const context = mentor(), billing = run(104);
    expect(await attachResearchTurn({ admin: full(), context, billing, fits: () => true, now: () => now })).toBe(true);
    expect(context).toMatchObject({ maxTurns: 3, maxToolCalls: 2 });
    expect(context.tools.slice(0, 2)).toEqual(['ask_question', 'read_skill_file']);
    expect(context.tools).toHaveLength(8);
    expect(billing.limits.maxCalls).toBe(3 + 1 + 12);
    // 0.15 + one more model call (0.05) + 12 subcalls × the largest tool bound (0.01).
    expect(billing.limits.costUsd).toBe('0.320000000000');
    expect((billing.callPolicy as unknown[]).length).toBe(1 + 5);
    // The message budget is frozen again for the extra serial tool round.
    expect(context.historyItems).toBe(104 - (2 + 4 * 2));
  });

  it('changes nothing when the profile cannot carry the extra tools or round', async () => {
    // 2 + 4 × min(2 tool calls, 2 more turns) = 10 messages exceed 9.
    for (const billing of [run(128, 4), run(9)]) {
      const context = mentor();
      expect(await attachResearchTurn({ admin: full(), context, billing, fits: () => true, now: () => now })).toBe(false);
      expect(context).toEqual(mentor());
      expect(billing.limits.maxCalls).toBe(3);
    }
  });
});

describe('frozen research context', () => {
  const base = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'skill', input: 'hi', instructions: 'x', model: 'vendor/model',
    maxOutputTokens: 100, historyItems: 0, providerRequestFormat: 'agent-turn-v5-stream', network: 'deny',
    opcTurnToken: admin, inputSelection: 'scope-projection-v2',
    historySelection: { version: 'block-cut-v1', blockRevisions: 16, currentReserveBytes: 8000, markerReserveBytes: 150 },
    hostTurnContext: { stepId: 's', opening: false, checklist: [] } };
  it('pairs research tools with their frozen research and one extra slot', async () => {
    const research = (await admitResearchTurn(input(full())))!.research;
    const ok = { ...base, tools: ['ask_question', 'web_search'], research, maxTurns: 2, maxToolCalls: 2 };
    expect(runtimeContext.safeParse(ok).success).toBe(true);
    expect(runtimeContext.safeParse({ ...ok, research: undefined }).success).toBe(false);
    expect(runtimeContext.safeParse({ ...ok, tools: ['ask_question'] }).success).toBe(false);
    expect(runtimeContext.safeParse({ ...ok, maxTurns: 1, maxToolCalls: 1 }).success).toBe(false);
    expect(runtimeContext.safeParse({ ...ok, maxTurns: 3 }).success).toBe(false);
    expect(runtimeContext.safeParse({ ...ok, hostTurnContext: { ...base.hostTurnContext, opening: true } }).success).toBe(false);
  });
});
