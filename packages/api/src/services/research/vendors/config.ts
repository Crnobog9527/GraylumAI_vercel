/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// research_tools_config (plan §5): admin switches, verified platforms and the route table. RT-1 only
// reads and validates it; the concurrency-checked write path and admin page are RT-2b. Missing or
// invalid configuration means every research call stays off.
import { z } from 'zod';
import { rowFor, type ConfigurationRows } from '../../runtime/settingsRows';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parallelRoute } from './parallel';
import { FIRECRAWL_ROUTE } from './firecrawl';
import { tikhubRouteId } from './tikhub';
import {
  RESEARCH_VENDORS, SOCIAL_KINDS, SOCIAL_PLATFORMS,
  type ResearchVendor, type SocialKind, type SocialPlatform,
} from './types';

export const RESEARCH_TOOLS_KEY = 'research_tools_config';

/**
 * Product rules from Master Plan §3.7 (D15, R11). They are server constants, not admin settings:
 * changing them needs a new Owner decision (plan §1).
 */
export const BENCHMARK_RULES = Object.freeze({
  followersMin: 10_000,
  followersMax: 200_000,
  activeWithinDays: 30,
  candidatesMin: 8,
  candidatesMax: 12,
  postsMin: 20,
  postsMax: 30,
  qualifiedMin: 3,
});

/**
 * Per platform, the query kinds one benchmark account needs (each kind is one billed sub-call) and which of them
 * carries the exact follower count. A benchmark needs exact followers plus an absolute publication time for the
 * 30-day rule. `verified` is set in code only after RT-7 checked the routes against recorded real responses
 * (plan §6.1); an admin setting can never enable an unverified platform. Weibo and Instagram have no
 * benchmark route set yet. RT-7 checked Xiaohongshu and Douyin against real responses (follower counts and absolute
 * publication times are present; neither platform gives a usable view count, so `views` stays missing).
 *
 * - bilibili: the profile has no followers; they come from the separate relation call.
 * - xiaohongshu: no public view counts, so `views` is always missing.
 * - douyin: play counts are hidden (always 0 upstream), so `views` is always missing; the profile route needs the sec_user_id.
 * - youtube: channel videos have only relative times; one post_detail of the newest video gives that video's absolute
 *   date and the channel's subscriber label. YouTube only publishes rounded counts, so its followers are approximate and
 *   judged conservatively (Owner 2026-10-23, vendors/approxCount.ts). Checked against real responses on 2026-10-23
 *   (BENCHMARK-COVERAGE): the channel list is newest first, 30 videos per page. Other videos keep publishedAt missing.
 */
export interface BenchmarkRouteSet { kinds: readonly SocialKind[]; followersFrom: SocialKind; verified: boolean }
const routeSet = (kinds: SocialKind[], followersFrom: SocialKind, verified: boolean): Readonly<BenchmarkRouteSet> =>
  Object.freeze({ kinds: Object.freeze(kinds), followersFrom, verified });
export const BENCHMARK_ROUTE_KINDS: Readonly<Partial<Record<SocialPlatform, Readonly<BenchmarkRouteSet>>>> = Object.freeze({
  tiktok: routeSet(['account_profile', 'account_posts'], 'account_profile', true),
  x: routeSet(['account_profile', 'account_posts'], 'account_profile', true),
  bilibili: routeSet(['account_profile', 'account_relation', 'account_posts'], 'account_relation', false),
  xiaohongshu: routeSet(['account_profile', 'account_posts'], 'account_profile', true),
  douyin: routeSet(['account_profile', 'account_posts'], 'account_profile', true),
  youtube: routeSet(['account_posts', 'post_detail'], 'post_detail', true),
});

/**
 * Extra `account_posts` pages a platform may need to reach the 20-post rule when one page falls short. Each extra
 * page is a billed sub-call of the same fetch and counts against the round allowance.
 */
export const BENCHMARK_EXTRA_POST_PAGES: Readonly<Partial<Record<SocialPlatform, number>>> = Object.freeze({
  xiaohongshu: 2,
  tiktok: 1,
  douyin: 1,
});

/** RT-3a budgets at most this many sub-calls per benchmark account inside the run's 32-call ceiling. */
export const MAX_BENCHMARK_SUBCALLS_PER_ACCOUNT = 3;
for (const [platform, entry] of Object.entries(BENCHMARK_ROUTE_KINDS)) {
  if (entry!.kinds.length > MAX_BENCHMARK_SUBCALLS_PER_ACCOUNT || !entry!.kinds.includes(entry!.followersFrom)) {
    throw new Error(`BENCHMARK_ROUTE_KINDS ${platform}: too many sub-calls or followers from an unlisted kind`);
  }
}

/** Billed sub-calls one benchmark account needs on `platform`; 0 when the platform has no benchmark route set. */
export function benchmarkSubcallsPerAccount(platform: SocialPlatform): number {
  return BENCHMARK_ROUTE_KINDS[platform]?.kinds.length ?? 0;
}

/** Platforms whose benchmark routes are verified (derived from the table; changing it is a code change). */
export const BENCHMARK_CAPABLE_PLATFORMS: readonly SocialPlatform[] = Object.freeze(
  (Object.keys(BENCHMARK_ROUTE_KINDS) as SocialPlatform[]).filter(platform => BENCHMARK_ROUTE_KINDS[platform]!.verified));

/** Run ceiling enforced by bill2_payg_validate_quote (0162); subcalls must fit beside model calls. */
export const RUN_MAX_CALLS = 32;

const isoTime = z.string().datetime({ offset: true });
const attestation = z.object({ by: z.string().uuid(), at: isoTime }).strict();
const vendorSchema = z.object({ enabled: z.boolean(), hardCapAttested: attestation.nullable() }).strict()
  .refine(v => !v.enabled || v.hardCapAttested !== null, 'A supplier can only be enabled after its platform hard cap is attested');
/**
 * Every adapter route is pinned to one unit per call (plan §3.5), so the frozen bound must be exactly that;
 * a larger typo would over-reserve the user's balance. A route with a different ceiling changes this code.
 */
const ADAPTER_MAX_UNITS = '1';

const routeSchema = z.object({
  platform: z.enum([...SOCIAL_PLATFORMS, 'web']),
  // web_search = Parallel fast; web_search_pro = Parallel advanced. Separate kinds keep route, request and frozen price aligned.
  kind: z.enum([...SOCIAL_KINDS, 'web_search', 'web_search_pro', 'web_fetch']),
  vendor: z.enum(RESEARCH_VENDORS),
  route: z.string().min(1).max(120),
  // Only primary routes are approved today (Bright Data backup needs a separate Owner approval, RT-9).
  backup: z.null(),
  maxUnitsPerCall: z.literal(ADAPTER_MAX_UNITS),
}).strict();

const configShape = {
  version: z.literal(1),
  enabled: z.boolean(),
  vendors: z.object({ tikhub: vendorSchema, parallel: vendorSchema, firecrawl: vendorSchema }).strict(),
  /** Platforms whose verified routes may be used at all. */
  verifiedPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length),
  /**
   * Subset usable for benchmarks: it also needs reliable publication times (30-day rule). YouTube and
   * Instagram stay out until RT-7 verifies time-bearing routes, while their other lookups remain usable.
   */
  benchmarkPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length),
  routes: z.array(routeSchema).max(64),
  limits: z.object({
    maxSubcallsPerRound: z.number().int().min(1).max(RUN_MAX_CALLS - 3),
    discoverSubcalls: z.number().int().min(1).max(RUN_MAX_CALLS - 3),
  }).strict(),
  recentGrowth: z.object({
    maxFirstPostAgeDays: z.number().int().min(1).max(365),
    minViewsToFollowers: z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,4})?$/),
  }).strict(),
};

type ConfigBody = z.infer<z.ZodObject<typeof configShape>>;

function checkConfig(config: ConfigBody, ctx: z.RefinementCtx) {
  config.benchmarkPlatforms.forEach((platform, index) => {
    if (!config.verifiedPlatforms.includes(platform)) {
      ctx.addIssue({ code: 'custom', path: ['benchmarkPlatforms', index], message: `${platform} is not a verified platform` });
    }
    if (!BENCHMARK_CAPABLE_PLATFORMS.includes(platform)) {
      ctx.addIssue({ code: 'custom', path: ['benchmarkPlatforms', index], message: `${platform} routes cannot supply benchmark fields yet` });
    }
    // A benchmark fetch needs every route its platform's benchmark set lists (plan §1.1, §1.2).
    for (const kind of BENCHMARK_ROUTE_KINDS[platform]?.kinds ?? []) {
      if (!config.routes.some(entry => entry.platform === platform && entry.kind === kind)) {
        ctx.addIssue({ code: 'custom', path: ['benchmarkPlatforms', index], message: `${platform} needs a configured ${kind} route` });
      }
    }
  });
  const seen = new Set<string>();
  config.routes.forEach((entry, index) => {
    const key = `${entry.platform}:${entry.kind}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['routes', index], message: `Duplicate route ${key}` });
    seen.add(key);
    if (expectedRoute(entry.platform, entry.kind, entry.vendor) !== entry.route) {
      ctx.addIssue({ code: 'custom', path: ['routes', index, 'route'], message: `Unknown ${entry.vendor} route for ${key}` });
    }
  });
}

export const researchToolsConfigSchema = z.object(configShape).strict().superRefine(checkConfig);

/** What the 0254 writer stores: the config plus server-written revision, author and time. */
export const storedResearchToolsSchema = z.object({
  ...configShape,
  revision: z.number().int().min(1).max(9999999999),
  updatedBy: z.string().uuid(),
  updatedAt: isoTime,
}).strict().superRefine(checkConfig);

export type ResearchToolsConfig = z.infer<typeof researchToolsConfigSchema>;
type RoutePlatform = ResearchToolsConfig['routes'][number]['platform'];
type RouteKind = ResearchToolsConfig['routes'][number]['kind'];

/** The adapter route a config entry must name; null when no verified adapter route exists. */
function expectedRoute(platform: RoutePlatform, kind: RouteKind, vendor: ResearchVendor): string | null {
  if (platform === 'web') {
    if (kind === 'web_search' && vendor === 'parallel') return parallelRoute('fast');
    if (kind === 'web_search_pro' && vendor === 'parallel') return parallelRoute('advanced');
    if (kind === 'web_fetch' && vendor === 'firecrawl') return FIRECRAWL_ROUTE;
    return null;
  }
  if (kind === 'web_search' || kind === 'web_search_pro' || kind === 'web_fetch' || vendor !== 'tikhub') return null;
  return tikhubRouteId(platform, kind);
}

export const DISABLED_RESEARCH_TOOLS: ResearchToolsConfig = Object.freeze({
  version: 1, enabled: false,
  vendors: {
    tikhub: { enabled: false, hardCapAttested: null },
    parallel: { enabled: false, hardCapAttested: null },
    firecrawl: { enabled: false, hardCapAttested: null },
  },
  verifiedPlatforms: [], benchmarkPlatforms: [], routes: [],
  limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
  recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
}) as ResearchToolsConfig;

/**
 * The revision the 0254 writer will compare against: PostgreSQL's own `value->>'revision'` text
 * (JSON decoding would turn `1.0` into 1), with the same rule as the SQL, otherwise 0. So a repair
 * save of an invalid row never conflicts.
 */
function storedRevision(revisionText: unknown): number {
  return typeof revisionText === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(revisionText) ? Number(revisionText) : 0;
}

export interface ResearchToolsState {
  config: ResearchToolsConfig;
  source: 'configured' | 'default' | 'invalid';
  revision: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * Reads the stored config; absent, unreadable or invalid → everything off (fail closed). An invalid
 * stored value still reports its revision so an admin can overwrite it with a valid one.
 */
/** DB-PERF PR-3: `configuration` is a new admission's settings rows (runtime/settingsRows.ts); absent, it is read now. */
export async function readResearchToolsConfig(db: SupabaseClient, configuration?: Promise<ConfigurationRows>): Promise<ResearchToolsState> {
  const off = (source: ResearchToolsState['source'], revision = 0): ResearchToolsState =>
    ({ config: DISABLED_RESEARCH_TOOLS, source, revision, updatedBy: null, updatedAt: null });
  try {
    // Value and PostgreSQL's revision text come from one request, so they describe one snapshot.
    const { data, error } = configuration ? withRevision(rowFor(await configuration, RESEARCH_TOOLS_KEY))
      : await db.from('system_settings').select('value,revision:value->>revision').eq('key', RESEARCH_TOOLS_KEY).maybeSingle();
    if (error) return off('invalid');
    if (!data) return off('default');
    const raw = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    const parsed = storedResearchToolsSchema.safeParse(raw);
    if (!parsed.success) return off('invalid', storedRevision((data as { revision?: unknown }).revision));
    const { revision, updatedBy, updatedAt, ...config } = parsed.data;
    return { config, source: 'configured', revision, updatedBy, updatedAt };
  } catch {
    return off('invalid');
  }
}

/** The row as `select('value,revision:value->>revision')` returns it: PostgreSQL's `->>` gives a string member as is,
 * any other member as its JSON text, and null for a missing member or a value that is not an object. */
function withRevision(read: { data: { value: unknown } | null; error: unknown }) {
  if (read.error || !read.data) return { data: null, error: read.error };
  const value = read.data.value;
  const member = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).revision : undefined;
  const revision = member === undefined || member === null ? null : typeof member === 'string' ? member : JSON.stringify(member);
  return { data: { value, revision }, error: null };
}

export type RouteSelection =
  | { ok: true; vendor: ResearchVendor; route: string; maxUnitsPerCall: string }
  | { ok: false; reason: 'RESEARCH_DISABLED' | 'PLATFORM_NOT_VERIFIED' | 'ROUTE_NOT_CONFIGURED' | 'VENDOR_DISABLED' };

/**
 * The host, not the model, picks the supplier: platform + query kind → configured primary route.
 * `purpose: 'benchmark'` additionally requires the platform to be benchmark-eligible.
 */
export function selectRoute(
  config: ResearchToolsConfig, platform: SocialPlatform | 'web', kind: RouteKind, purpose: 'general' | 'benchmark' = 'general',
): RouteSelection {
  if (!config.enabled) return { ok: false, reason: 'RESEARCH_DISABLED' };
  if (platform !== 'web') {
    const list = purpose === 'benchmark' ? config.benchmarkPlatforms : config.verifiedPlatforms;
    if (!list.includes(platform)) return { ok: false, reason: 'PLATFORM_NOT_VERIFIED' };
  }
  const entry = config.routes.find(item => item.platform === platform && item.kind === kind);
  if (!entry) return { ok: false, reason: 'ROUTE_NOT_CONFIGURED' };
  if (!config.vendors[entry.vendor].enabled) return { ok: false, reason: 'VENDOR_DISABLED' };
  return { ok: true, vendor: entry.vendor, route: entry.route, maxUnitsPerCall: entry.maxUnitsPerCall };
}

/**
 * Whether official usage stayed within the frozen per-call bound. null = no official usage to compare.
 * A false result means the route must fail closed for new calls until revalidated (plan §3.5).
 */
export function usageWithinBound(units: string | null, maxUnitsPerCall: string): boolean | null {
  if (units === null) return null;
  const [whole, fraction = ''] = units.split('.');
  const max = BigInt(maxUnitsPerCall);
  const used = BigInt(whole);
  return used < max || (used === max && /^0*$/.test(fraction));
}
