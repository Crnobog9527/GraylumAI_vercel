/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseProfileLink } from '../research/tools/accountLinks';
import { readResearchToolsConfig } from '../research/vendors/config';
import { TIKHUB_ROUTES } from '../research/vendors/tikhub';
import type { ResearchCallResult, ResearchItem, SocialPlatform } from '../research/vendors/types';

/**
 * PUBLISH-MONITOR PR-4a (plan §4.2): the user's own Xiaohongshu/Douyin accounts and Gold benchmark accounts, read
 * through the RESEARCH-TOOLS TikHub adapter (no second TikHub client). Public data only, no authorization: a profile
 * link is parsed on the server into the canonical TikHub account id. This module manages the connections and turns a
 * read's adapter results into rows; the billed read itself (BILL2 background runs) is PR-4b, so nothing here calls
 * TikHub or charges credits.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
const uuid = z.string().uuid();

/** Own accounts read through TikHub (plan §1): the overseas platforms come through Post for Me instead. */
export const OWN_TIKHUB_PLATFORMS: readonly SocialPlatform[] = ['xiaohongshu', 'douyin'];
export const BENCHMARK_LIMIT_SETTING = 'publish_monitor_benchmark_limit';
export const DEFAULT_BENCHMARK_LIMIT = 5;
const POST_METRICS = ['views', 'likes', 'comments', 'shares'] as const;
const PROFILE_METRICS = ['followers', 'following', 'postsCount', 'likesTotal'] as const;

export type TikhubErrorCode = 'PUBLISH_MONITOR_PROFILE_LINK_INVALID' | 'PUBLISH_MONITOR_PLATFORM_UNSUPPORTED'
  | 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' | 'PUBLISH_MONITOR_ACCOUNT_CLOSED' | 'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED'
  | 'PUBLISH_MONITOR_BENCHMARK_EXISTS' | 'PUBLISH_MONITOR_BENCHMARK_LIMIT' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class TikhubConnectionError extends Error {
  constructor(readonly code: TikhubErrorCode) { super(code); }
}
const KNOWN: TikhubErrorCode[] = ['PUBLISH_MONITOR_PLATFORM_UNSUPPORTED', 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND',
  'PUBLISH_MONITOR_ACCOUNT_CLOSED', 'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED', 'PUBLISH_MONITOR_BENCHMARK_EXISTS',
  'PUBLISH_MONITOR_BENCHMARK_LIMIT'];

async function call<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) {
    throw new TikhubConnectionError(KNOWN.find(code => result.error?.message?.includes(code)) ?? 'PUBLISH_MONITOR_UNAVAILABLE');
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new TikhubConnectionError('PUBLISH_MONITOR_UNAVAILABLE');
  return parsed.data;
}

function profileOf(link: string) {
  const parsed = parseProfileLink(link.trim());
  if (!parsed) throw new TikhubConnectionError('PUBLISH_MONITOR_PROFILE_LINK_INVALID');
  return parsed;
}

export const tikhubConnectInput = z.object({ accountProjectId: uuid, profileLink: z.string().min(1).max(2048),
  autoTrack: z.boolean() }).strict();

/** Connects one of the user's own Xiaohongshu/Douyin brand accounts by its full profile link. */
export async function connectOwnTikhub(db: Rpc, profileId: string, input: z.infer<typeof tikhubConnectInput>) {
  const { accountProjectId, profileLink, autoTrack } = tikhubConnectInput.parse(input);
  const profile = profileOf(profileLink);
  if (!OWN_TIKHUB_PLATFORMS.includes(profile.platform)) throw new TikhubConnectionError('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
  return call(db, 'publish_monitor_tikhub_connect', { a: uuid.parse(profileId), p_account_project_id: accountProjectId,
    p_platform: profile.platform, p_profile_ref: profile.account, p_auto_track: autoTrack },
  z.object({ connectionId: uuid, platform: z.string() }).strict());
}

/**
 * Platforms a benchmark may be on: Xiaohongshu and Douyin, plus the overseas platforms RESEARCH-TOOLS has verified
 * (plan §4.2: "海外平台对标沿用 RESEARCH-TOOLS 已验证平台清单") that have both a profile and a post-list route.
 */
export async function benchmarkPlatforms(db: Pick<SupabaseClient, 'from'>): Promise<SocialPlatform[]> {
  const { config } = await readResearchToolsConfig(db as SupabaseClient);
  const overseas = config.verifiedPlatforms.filter(platform => Boolean(TIKHUB_ROUTES[`${platform}:account_profile`])
    && Boolean(TIKHUB_ROUTES[`${platform}:account_posts`]));
  return [...new Set([...OWN_TIKHUB_PLATFORMS, ...overseas])];
}

/** Admin cap on benchmark accounts per brand; a missing or malformed value falls back to the default. */
export async function readBenchmarkLimit(db: Pick<SupabaseClient, 'from'>): Promise<number> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', BENCHMARK_LIMIT_SETTING).maybeSingle();
  const value = error ? null : data?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50 ? value : DEFAULT_BENCHMARK_LIMIT;
}

export const benchmarkAddInput = z.object({ businessId: uuid, profileLink: z.string().min(1).max(2048),
  displayHint: z.string().trim().max(64).optional() }).strict();

/** Adds a benchmark account to a brand (Gold only; the caller checks the entitlement first). */
export async function addBenchmark(db: Db, profileId: string, input: z.infer<typeof benchmarkAddInput>) {
  const { businessId, profileLink, displayHint } = benchmarkAddInput.parse(input);
  const profile = profileOf(profileLink);
  if (!(await benchmarkPlatforms(db)).includes(profile.platform)) {
    throw new TikhubConnectionError('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
  }
  return call(db, 'publish_monitor_benchmark_add', { a: uuid.parse(profileId), p_business_id: businessId,
    p_platform: profile.platform, p_profile_ref: profile.account, p_display_hint: displayHint ?? null,
    p_max: await readBenchmarkLimit(db) }, z.object({ connectionId: uuid, platform: z.string(), count: z.number().int() }).strict());
}

export const tikhubClaimSchema = z.object({
  connectionId: uuid, actorId: uuid, businessId: uuid, role: z.enum(['own', 'benchmark']), lease: uuid, refreshId: uuid,
  platform: z.string().regex(/^[a-z0-9_-]{1,32}$/), account: z.string().min(1).max(160), knownPosts: z.number().int().min(0),
}).strict();
export type TikhubClaim = z.infer<typeof tikhubClaimSchema>;

type Row = { metrics: Record<string, number>; missingFields: string[] };

function metricsOf(item: ResearchItem, names: readonly string[]): Row {
  const metrics: Record<string, number> = {};
  const missingFields: string[] = [];
  for (const name of names) {
    const value = item.fields[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[name] = value;
    // Absent or unreadable (e.g. Xiaohongshu has no view count): listed as missing, never written as zero.
    else missingFields.push(name);
  }
  return { metrics, missingFields: missingFields.sort() };
}

/** Rows for publish_monitor_tikhub_write from the adapter's normalized profile and post results. */
export function tikhubRows(profile: ResearchCallResult | null, posts: ResearchCallResult) {
  const profileItem = profile && (profile.outcome === 'ok' || profile.outcome === 'partial') ? profile.items[0] : undefined;
  return {
    profile: profileItem ? metricsOf(profileItem, PROFILE_METRICS) : null,
    posts: (posts.outcome === 'ok' || posts.outcome === 'partial' ? posts.items : [])
      .filter(item => typeof item.fields.id === 'string' || typeof item.fields.id === 'number')
      .map(item => {
        const title = typeof item.fields.title === 'string' ? item.fields.title : null;
        const published = typeof item.fields.publishedAt === 'string' && Number.isFinite(Date.parse(item.fields.publishedAt))
          ? new Date(item.fields.publishedAt).toISOString() : null;
        return { platformPostId: String(item.fields.id).slice(0, 256), url: item.url ?? null, postedAt: published,
          titleExcerpt: title ? [...title].slice(0, 120).join('') : null, ...metricsOf(item, POST_METRICS) };
      }),
  };
}

/**
 * How a read settles (0272's publish_monitor_refresh_finish): a post list, even with some posts, is done; TikHub's own
 * "no results" is empty (the database applies the empty-list rules); anything else keeps old data as "not fetched".
 * A refused or unknown account is a failed read, never "re-authorise" (there is no authorization to renew).
 */
export function tikhubOutcome(posts: ResearchCallResult): { outcome: 'done' | 'empty' | 'failed'; error: string | null } {
  if (posts.outcome === 'ok' && posts.reason === 'NO_RESULTS') return { outcome: 'empty', error: null };
  if (posts.outcome === 'ok' || posts.outcome === 'partial') return { outcome: 'done', error: null };
  return { outcome: 'failed', error: `TIKHUB_${(posts.reason ?? posts.outcome).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 64) };
}

const writeResult = z.union([z.object({ stale: z.literal(true) }).strict(),
  z.object({ stale: z.literal(false), inserted: z.number().int().min(0), existing: z.number().int().min(0) }).strict()]);

/** Writes one read and settles the claim; false when the claim was no longer current (nothing changed). */
export async function applyTikhubRead(db: Rpc, claim: TikhubClaim, profile: ResearchCallResult | null,
  posts: ResearchCallResult, evidenceRef: string): Promise<boolean> {
  const rows = tikhubRows(profile, posts);
  const settled = tikhubOutcome(posts);
  const keys = { p_connection_id: claim.connectionId, p_lease: claim.lease, p_refresh_id: claim.refreshId };
  if (settled.outcome === 'done' || rows.profile) {
    const written = await call(db, 'publish_monitor_tikhub_write', { ...keys, p_profile: rows.profile, p_posts: rows.posts,
      p_evidence_ref: evidenceRef }, writeResult);
    if (written.stale) return false;
  }
  return call(db, 'publish_monitor_refresh_finish', { ...keys, p_outcome: settled.outcome, p_error: settled.error }, z.boolean());
}
