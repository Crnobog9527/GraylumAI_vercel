/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BENCHMARK_RULES, DISABLED_RESEARCH_TOOLS, readResearchToolsConfig, researchToolsConfigSchema, selectRoute,
  usageWithinBound, type ResearchToolsConfig,
} from '../config';

const attested = { by: '00000000-0000-4000-8000-000000000001', at: '2026-10-13T00:00:00Z' };
const valid = (): ResearchToolsConfig => ({
  version: 1, enabled: true,
  vendors: {
    tikhub: { enabled: true, hardCapAttested: attested },
    parallel: { enabled: true, hardCapAttested: attested },
    firecrawl: { enabled: false, hardCapAttested: null },
  },
  verifiedPlatforms: ['tiktok'],
  routes: [
    { platform: 'tiktok', kind: 'account_posts', vendor: 'tikhub', route: '/tiktok/app/v3/fetch_user_post_videos', backup: null, maxUnitsPerCall: '1' },
    { platform: 'x', kind: 'account_profile', vendor: 'tikhub', route: '/twitter/web/fetch_user_profile', backup: null, maxUnitsPerCall: '1' },
    { platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:advanced', backup: null, maxUnitsPerCall: '1' },
    { platform: 'web', kind: 'web_fetch', vendor: 'firecrawl', route: 'firecrawl:scrape:markdown', backup: null, maxUnitsPerCall: '1' },
  ],
  limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
  recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
});

function dbReturning(value: unknown, error: unknown = null): SupabaseClient {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: value === undefined ? null : { value }, error }) };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe('research_tools_config', () => {
  it('keeps the approved benchmark rules as constants', () => {
    expect(BENCHMARK_RULES).toEqual({ followersMin: 10_000, followersMax: 200_000, activeWithinDays: 30,
      candidatesMin: 8, candidatesMax: 12, postsMin: 20, postsMax: 30, qualifiedMin: 3 });
    expect(Object.isFrozen(BENCHMARK_RULES)).toBe(true);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), benchmark: { followersMin: 1 } }).success).toBe(false);
  });

  it('accepts a valid config and rejects unattested suppliers, unknown routes, backups and duplicates', () => {
    expect(researchToolsConfigSchema.safeParse(valid()).success).toBe(true);
    const unattested = valid();
    unattested.vendors.firecrawl = { enabled: true, hardCapAttested: null };
    expect(researchToolsConfigSchema.safeParse(unattested).success).toBe(false);
    const v5 = valid();
    v5.routes[0] = { ...v5.routes[0], platform: 'douyin', kind: 'keyword_posts', route: '/douyin/search/fetch_video_search_v5' };
    expect(researchToolsConfigSchema.safeParse(v5).success).toBe(false);
    const mismatched = valid();
    mismatched.routes[2] = { ...mismatched.routes[2], vendor: 'firecrawl' };
    expect(researchToolsConfigSchema.safeParse(mismatched).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), routes: [{ ...valid().routes[0], backup: 'brightdata' }] }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), routes: [valid().routes[0], valid().routes[0]] }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), limits: { maxSubcallsPerRound: 32, discoverSubcalls: 25 } }).success).toBe(false);
  });

  it('fails closed when the setting is absent, unreadable or invalid', async () => {
    expect(await readResearchToolsConfig(dbReturning(undefined))).toEqual({ config: DISABLED_RESEARCH_TOOLS, source: 'default' });
    expect(await readResearchToolsConfig(dbReturning(null, { message: 'down' }))).toMatchObject({ source: 'invalid', config: { enabled: false } });
    expect(await readResearchToolsConfig(dbReturning({ version: 2 }))).toMatchObject({ source: 'invalid', config: { enabled: false } });
    expect(await readResearchToolsConfig(dbReturning('{broken'))).toMatchObject({ source: 'invalid' });
    expect(await readResearchToolsConfig(dbReturning(JSON.stringify(valid())))).toMatchObject({ source: 'configured', config: { enabled: true } });
  });
});

describe('selectRoute', () => {
  it('lets the host, not the model, pick the supplier and refuses anything not switched on', () => {
    const config = valid();
    expect(selectRoute(config, 'tiktok', 'account_posts')).toEqual({ ok: true, vendor: 'tikhub',
      route: '/tiktok/app/v3/fetch_user_post_videos', maxUnitsPerCall: '1' });
    expect(selectRoute(config, 'x', 'account_profile')).toEqual({ ok: false, reason: 'PLATFORM_NOT_VERIFIED' });
    expect(selectRoute(config, 'tiktok', 'keyword_posts')).toEqual({ ok: false, reason: 'ROUTE_NOT_CONFIGURED' });
    expect(selectRoute(config, 'web', 'web_fetch')).toEqual({ ok: false, reason: 'VENDOR_DISABLED' });
    expect(selectRoute(config, 'web', 'web_search')).toMatchObject({ ok: true, vendor: 'parallel' });
    expect(selectRoute({ ...config, enabled: false }, 'web', 'web_search')).toEqual({ ok: false, reason: 'RESEARCH_DISABLED' });
  });
});

describe('usageWithinBound', () => {
  it('compares official usage with the frozen per-call bound exactly', () => {
    expect(usageWithinBound('1', '1')).toBe(true);
    expect(usageWithinBound('0.5', '1')).toBe(true);
    expect(usageWithinBound('1.0', '1')).toBe(true);
    expect(usageWithinBound('1.01', '1')).toBe(false);
    expect(usageWithinBound('2', '1')).toBe(false);
    expect(usageWithinBound(null, '1')).toBeNull();
  });
});
