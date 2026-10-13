/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// research_tools_config (plan §5): admin switches, verified platforms and the route table. RT-1 only
// reads and validates it; the concurrency-checked write path and admin page are RT-2b. Missing or
// invalid configuration means every research call stays off.
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PARALLEL_ROUTES } from './parallel';
import { FIRECRAWL_ROUTE } from './firecrawl';
import { tikhubRouteId } from './tikhub';
import {
  RESEARCH_VENDORS, SOCIAL_KINDS, SOCIAL_PLATFORMS,
  type ResearchVendor, type SocialPlatform,
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

/** Run ceiling enforced by bill2_payg_validate_quote (0162); subcalls must fit beside model calls. */
export const RUN_MAX_CALLS = 32;

const isoTime = z.string().datetime({ offset: true });
const attestation = z.object({ by: z.string().uuid(), at: isoTime }).strict();
const vendorSchema = z.object({ enabled: z.boolean(), hardCapAttested: attestation.nullable() }).strict()
  .refine(v => !v.enabled || v.hardCapAttested !== null, 'A supplier can only be enabled after its platform hard cap is attested');
const units = z.string().regex(/^[1-9]\d{0,5}$/);

const routeSchema = z.object({
  platform: z.enum([...SOCIAL_PLATFORMS, 'web']),
  kind: z.enum([...SOCIAL_KINDS, 'web_search', 'web_fetch']),
  vendor: z.enum(RESEARCH_VENDORS),
  route: z.string().min(1).max(120),
  // Only primary routes are approved today (Bright Data backup needs a separate Owner approval, RT-9).
  backup: z.null(),
  maxUnitsPerCall: units,
}).strict();

export const researchToolsConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  vendors: z.object({ tikhub: vendorSchema, parallel: vendorSchema, firecrawl: vendorSchema }).strict(),
  verifiedPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length),
  routes: z.array(routeSchema).max(64),
  limits: z.object({
    maxSubcallsPerRound: z.number().int().min(1).max(RUN_MAX_CALLS - 3),
    discoverSubcalls: z.number().int().min(1).max(RUN_MAX_CALLS - 3),
  }).strict(),
  recentGrowth: z.object({
    maxFirstPostAgeDays: z.number().int().min(1).max(365),
    minViewsToFollowers: z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,4})?$/),
  }).strict(),
}).strict().superRefine((config, ctx) => {
  const seen = new Set<string>();
  config.routes.forEach((entry, index) => {
    const key = `${entry.platform}:${entry.kind}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['routes', index], message: `Duplicate route ${key}` });
    seen.add(key);
    if (expectedRoute(entry.platform, entry.kind, entry.vendor, entry.route) !== entry.route) {
      ctx.addIssue({ code: 'custom', path: ['routes', index, 'route'], message: `Unknown ${entry.vendor} route for ${key}` });
    }
  });
});

export type ResearchToolsConfig = z.infer<typeof researchToolsConfigSchema>;
type RoutePlatform = ResearchToolsConfig['routes'][number]['platform'];
type RouteKind = ResearchToolsConfig['routes'][number]['kind'];

/** The adapter route a config entry must name; null when no verified adapter route exists. */
function expectedRoute(platform: RoutePlatform, kind: RouteKind, vendor: ResearchVendor, route: string): string | null {
  if (platform === 'web') {
    if (kind === 'web_search' && vendor === 'parallel') return PARALLEL_ROUTES.includes(route) ? route : null;
    if (kind === 'web_fetch' && vendor === 'firecrawl') return FIRECRAWL_ROUTE;
    return null;
  }
  if (kind === 'web_search' || kind === 'web_fetch' || vendor !== 'tikhub') return null;
  return tikhubRouteId(platform, kind);
}

export const DISABLED_RESEARCH_TOOLS: ResearchToolsConfig = Object.freeze({
  version: 1, enabled: false,
  vendors: {
    tikhub: { enabled: false, hardCapAttested: null },
    parallel: { enabled: false, hardCapAttested: null },
    firecrawl: { enabled: false, hardCapAttested: null },
  },
  verifiedPlatforms: [], routes: [],
  limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
  recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
}) as ResearchToolsConfig;

/** Reads the stored config; absent, unreadable or invalid → everything off (fail closed). */
export async function readResearchToolsConfig(db: SupabaseClient): Promise<{ config: ResearchToolsConfig; source: 'configured' | 'default' | 'invalid' }> {
  try {
    const { data, error } = await db.from('system_settings').select('value').eq('key', RESEARCH_TOOLS_KEY).maybeSingle();
    if (error) return { config: DISABLED_RESEARCH_TOOLS, source: 'invalid' };
    if (!data) return { config: DISABLED_RESEARCH_TOOLS, source: 'default' };
    const raw = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    const parsed = researchToolsConfigSchema.safeParse(raw);
    return parsed.success ? { config: parsed.data, source: 'configured' } : { config: DISABLED_RESEARCH_TOOLS, source: 'invalid' };
  } catch {
    return { config: DISABLED_RESEARCH_TOOLS, source: 'invalid' };
  }
}

export type RouteSelection =
  | { ok: true; vendor: ResearchVendor; route: string; maxUnitsPerCall: string }
  | { ok: false; reason: 'RESEARCH_DISABLED' | 'PLATFORM_NOT_VERIFIED' | 'ROUTE_NOT_CONFIGURED' | 'VENDOR_DISABLED' };

/** The host, not the model, picks the supplier: platform + query kind → configured primary route. */
export function selectRoute(config: ResearchToolsConfig, platform: SocialPlatform | 'web', kind: RouteKind): RouteSelection {
  if (!config.enabled) return { ok: false, reason: 'RESEARCH_DISABLED' };
  if (platform !== 'web' && !config.verifiedPlatforms.includes(platform)) return { ok: false, reason: 'PLATFORM_NOT_VERIFIED' };
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
