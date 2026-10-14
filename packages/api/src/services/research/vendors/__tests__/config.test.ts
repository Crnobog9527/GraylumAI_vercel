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
  verifiedPlatforms: ['tiktok', 'instagram'],
  benchmarkPlatforms: ['tiktok'],
  routes: [
    { platform: 'tiktok', kind: 'account_posts', vendor: 'tikhub', route: '/tiktok/app/v3/fetch_user_post_videos', backup: null, maxUnitsPerCall: '1' },
    { platform: 'tiktok', kind: 'account_profile', vendor: 'tikhub', route: '/tiktok/app/v3/handler_user_profile', backup: null, maxUnitsPerCall: '1' },
    { platform: 'x', kind: 'account_profile', vendor: 'tikhub', route: '/twitter/web/fetch_user_profile', backup: null, maxUnitsPerCall: '1' },
    { platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' },
    { platform: 'web', kind: 'web_search_pro', vendor: 'parallel', route: 'parallel:search:advanced', backup: null, maxUnitsPerCall: '1' },
    { platform: 'web', kind: 'web_fetch', vendor: 'firecrawl', route: 'firecrawl:scrape:markdown', backup: null, maxUnitsPerCall: '1' },
  ],
  limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
  recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
});

/** `revisionText` is what PostgreSQL's value->>'revision' would return (defaults to the JSON value as text). */
function dbReturning(value: unknown, error: unknown = null, revisionText?: string | null): SupabaseClient {
  let columns = '';
  const pgText = () => {
    if (revisionText !== undefined) return revisionText;
    const raw = (typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value) as { revision?: unknown } | null;
    const r = raw?.revision;
    return r === undefined || r === null ? null : typeof r === 'string' ? r : JSON.stringify(r);
  };
  const chain = {
    select: (c: string) => { columns = c; return chain; }, eq: () => chain,
    maybeSingle: async () => ({ error, data: value === undefined ? null
      : columns.includes('revision:') ? { value, revision: pgText() } : { value } }),
  };
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
    mismatched.routes[3] = { ...mismatched.routes[3], vendor: 'firecrawl' };
    expect(researchToolsConfigSchema.safeParse(mismatched).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), routes: [{ ...valid().routes[0], backup: 'brightdata' }], benchmarkPlatforms: [] }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), routes: [valid().routes[0], valid().routes[0]], benchmarkPlatforms: [] }).success).toBe(false);
    // Control: the same reduced shapes are valid without the defect under test.
    expect(researchToolsConfigSchema.safeParse({ ...valid(), routes: [valid().routes[0]], benchmarkPlatforms: [] }).success).toBe(true);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), routes: [{ ...valid().routes[0], maxUnitsPerCall: '100000' }], benchmarkPlatforms: [] }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), benchmarkPlatforms: ['x'] }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), benchmarkPlatforms: ['tiktok', 'instagram'] }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), verifiedPlatforms: ['tiktok', 'x'], benchmarkPlatforms: ['tiktok', 'x'] }).success).toBe(false);
    const profileless = valid();
    profileless.routes = profileless.routes.filter(entry => !(entry.platform === 'tiktok' && entry.kind === 'account_profile'));
    expect(researchToolsConfigSchema.safeParse(profileless).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), limits: { maxSubcallsPerRound: 30, discoverSubcalls: 25 } }).success).toBe(false);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), limits: { maxSubcallsPerRound: 29, discoverSubcalls: 29 } }).success).toBe(true);
    expect(researchToolsConfigSchema.safeParse({ ...valid(), limits: { maxSubcallsPerRound: 12, discoverSubcalls: 30 } }).success).toBe(false);
  });

  it('fails closed when the setting is absent, unreadable or invalid', async () => {
    expect(await readResearchToolsConfig(dbReturning(undefined)))
      .toEqual({ config: DISABLED_RESEARCH_TOOLS, source: 'default', revision: 0, updatedBy: null, updatedAt: null });
    expect(await readResearchToolsConfig(dbReturning(null, { message: 'down' }))).toMatchObject({ source: 'invalid', config: { enabled: false } });
    expect(await readResearchToolsConfig(dbReturning({ version: 2 }))).toMatchObject({ source: 'invalid', config: { enabled: false } });
    expect(await readResearchToolsConfig(dbReturning('{broken'))).toMatchObject({ source: 'invalid' });
    const stored = { ...valid(), revision: 3, updatedBy: attested.by, updatedAt: '2026-10-14T00:00:00.000000Z' };
    expect(await readResearchToolsConfig(dbReturning(JSON.stringify(stored))))
      .toMatchObject({ source: 'configured', revision: 3, updatedBy: attested.by, config: { enabled: true } });
    // A value without the writer's revision/author was not written by 0254: fail closed, keep its revision visible.
    expect(await readResearchToolsConfig(dbReturning(valid()))).toMatchObject({ source: 'invalid', config: { enabled: false } });
    expect(await readResearchToolsConfig(dbReturning({ ...stored, enabled: 'yes' }))).toMatchObject({ source: 'invalid', revision: 3 });
    // Same revision rule as the 0254 SQL, so a repair save never conflicts.
    for (const [revision, expected] of [['01', 0], ['1e3', 0], [true, 0], [1.5, 0], ['7', 7], [-1, 0]] as const) {
      expect((await readResearchToolsConfig(dbReturning({ ...stored, enabled: 'yes', revision }))).revision).toBe(expected);
    }
    // JSON decoding turns a stored 1.0 into 1, but PostgreSQL sees "1.0" and uses 0: follow PostgreSQL.
    expect((await readResearchToolsConfig(dbReturning({ ...stored, enabled: 'yes', revision: 1 }, null, '1.0'))).revision).toBe(0);
  });
});

describe('selectRoute', () => {
  it('lets the host, not the model, pick the supplier and refuses anything not switched on', () => {
    const config = valid();
    expect(selectRoute(config, 'tiktok', 'account_posts')).toEqual({ ok: true, vendor: 'tikhub',
      route: '/tiktok/app/v3/fetch_user_post_videos', maxUnitsPerCall: '1' });
    expect(selectRoute(config, 'x', 'account_profile')).toEqual({ ok: false, reason: 'PLATFORM_NOT_VERIFIED' });
    // Instagram lookups are usable in general, but not for benchmarks until its post times are verified.
    const withInstagram = { ...config, routes: [...config.routes, { platform: 'instagram' as const, kind: 'account_profile' as const,
      vendor: 'tikhub' as const, route: '/instagram/v1/fetch_user_info_by_username', backup: null, maxUnitsPerCall: '1' as const }] };
    expect(selectRoute(withInstagram, 'instagram', 'account_profile')).toMatchObject({ ok: true });
    expect(selectRoute(withInstagram, 'instagram', 'account_profile', 'benchmark')).toEqual({ ok: false, reason: 'PLATFORM_NOT_VERIFIED' });
    expect(selectRoute(config, 'tiktok', 'account_posts', 'benchmark')).toMatchObject({ ok: true });
    expect(selectRoute(config, 'tiktok', 'keyword_posts')).toEqual({ ok: false, reason: 'ROUTE_NOT_CONFIGURED' });
    expect(selectRoute(config, 'web', 'web_fetch')).toEqual({ ok: false, reason: 'VENDOR_DISABLED' });
    expect(selectRoute(config, 'web', 'web_search')).toMatchObject({ ok: true, vendor: 'parallel', route: 'parallel:search:fast' });
    expect(selectRoute(config, 'web', 'web_search_pro')).toMatchObject({ ok: true, route: 'parallel:search:advanced' });
    const swapped = valid();
    swapped.routes[3] = { ...swapped.routes[3], route: 'parallel:search:advanced' };
    expect(researchToolsConfigSchema.safeParse(swapped).success).toBe(false);
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
