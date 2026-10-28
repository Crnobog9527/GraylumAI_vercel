/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import type { ResearchCallResult, ResearchVendor } from '../../research/vendors/types';
import type { CounterStore } from '../limiter';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../../research/vendors/config';
import { tikhubRouteId } from '../../research/vendors/tikhub';
import { FIRECRAWL_ROUTE } from '../../research/vendors/firecrawl';
import { CHAT_RESEARCH_KEY } from '../../runtime/freeChatResearch';
import { RESEARCH_PHASE } from '../../runtime/researchTurn';
import type { ToolCallDeps } from './types';

// Shared doubles for the V2-6 tool tests (a .test.ts file so the code-size and coverage rules treat it as test code).
export const quiet = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };

export function policy(vendor: ResearchVendor, route: string, price = '0.001', multiplier = '6'): ToolCallPolicy {
  const unit = vendor === 'tikhub' ? 'call' : vendor === 'parallel' ? 'sku_search' : 'credit';
  return { provider: vendor, account: 'research-production', model: `${vendor}:${route}`, protocol: 'research-tool-v1',
    modelId: '00000000-0000-0000-0000-000000000000', multiplier, lookupSupported: false, upperUsd: price, purposes: ['research'],
    toolPricing: { unit, currency: 'USD', price, unitsPerPrice: '1', usdPerCurrency: null, entryHash: 'a'.repeat(64),
      validUntil: '2099-01-01T00:00:00Z', maxUnitsPerCall: '1' } };
}

export function result(over: Partial<ResearchCallResult> & Pick<ResearchCallResult, 'vendor' | 'route'>): ResearchCallResult {
  return { outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
    usage: { unit: over.vendor === 'tikhub' ? 'call' : over.vendor === 'parallel' ? 'sku_search' : 'credit', units: '1' },
    items: [{ fields: { title: 'a post' }, missing: [] }], truncated: false, fetchedAt: '2026-10-28T00:00:00.000Z', ...over };
}

export const freeSlots: CounterStore = { take: async () => 1, drop: async () => undefined };

/** A database double that records every write. `begin` may answer paused/tombstoned or throw a code. */
export function ledger(over: { begin?: () => Record<string, unknown> | Error; record?: () => Record<string, unknown> } = {}) {
  const writes: Array<[string, Record<string, unknown>]> = [];
  let seq = 0;
  const db = {
    begin: vi.fn(async (a: Record<string, unknown>) => {
      const answer = over.begin?.();
      if (answer instanceof Error) throw answer;
      writes.push(['begin', a]);
      return { state: 'running', status: 'dispatched', ...quiet, ...answer };
    }),
    record: vi.fn(async (a: Record<string, unknown>) => { writes.push(['record', a]);
      return { status: a.status, creditsLow: false, ...quiet, ...over.record?.() }; }),
  } as unknown as ToolCallDeps['db'];
  const kinds = () => writes.map(([k, a]) => k + (k === 'record' ? ':' + String(a.status) : ''));
  return { writes, kinds, deps: { db, actorId: 'actor', turnId: 7, nextSeq: () => ++seq } satisfies ToolCallDeps };
}

// The research settings as freeChatResearch.test.ts seeds them (synthetic prices, never real ones).
const actor = '10000000-0000-4000-8000-000000000001', now = Date.now(), day = 86_400_000;
const routes = [...(['keyword_posts', 'account_profile', 'account_posts'] as const).map(kind => ({ platform: 'tiktok', kind, vendor: 'tikhub',
  route: tikhubRouteId('tiktok', kind)!, backup: null, maxUnitsPerCall: '1' })),
{ platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' },
{ platform: 'web', kind: 'web_fetch', vendor: 'firecrawl', route: FIRECRAWL_ROUTE, backup: null, maxUnitsPerCall: '1' }];
const price = (provider: string, route: string | null, usageUnit: string) => ({ provider, route, appliesToUnlistedRoutes: route === null,
  currency: 'USD', usageUnit, unitsPerPrice: '1', price: '0.01', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null,
  fxValidUntil: null, pricingBasis: 'list', sourceUrl: 'https://example.com/p', evidenceHash: 'a'.repeat(64),
  verifiedAt: new Date(now - day).toISOString(), validUntil: new Date(now + 7 * day).toISOString(), chargeCondition: 'per call',
  includedInReceipt: false, priceMultiplier: null });
export function researchSettings(switchOn = true): Record<string, unknown> {
  const vendor = { enabled: true, hardCapAttested: { by: actor, at: new Date(now).toISOString() } };
  return {
    [CHAT_RESEARCH_KEY]: switchOn,
    research_tools_config: { ...researchToolsConfigSchema.parse({ ...DISABLED_RESEARCH_TOOLS, enabled: true,
      vendors: { tikhub: vendor, parallel: vendor, firecrawl: vendor }, verifiedPlatforms: ['tiktok'], benchmarkPlatforms: ['tiktok'],
      routes, limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 } }), revision: 3, updatedBy: actor, updatedAt: new Date(now).toISOString() },
    billing_provider_prices: { version: 1, entries: [price('tikhub', null, 'call'), price('parallel', 'parallel:search:fast', 'sku_search'),
      price('firecrawl', FIRECRAWL_ROUTE, 'credit')] },
    billing_payg_start_thresholds: { version: 'v1', thresholds: routes.map(r => ({ model: `${r.vendor}:${r.route}`, purpose: RESEARCH_PHASE,
      credits: 1 })) },
  };
}


it('fixtures load', () => { expect(policy('tikhub', 'r').model).toBe('tikhub:r'); });
