/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { publicHttpsUrl } from './http';

// Measured 2026-10-13 (docs/launch/evidence/publish-monitor-20261013): every field below can be absent
// per platform; X never returns posted_at. Missing values are listed, never written as zero (plan §3.2).
export type NormalizedPost = {
  platformPostId: string;
  postedAt: string | null;
  postedAtSource: 'provider' | 'x_snowflake' | null;
  url: string | null;
  titleExcerpt: string | null;
  metrics: Record<string, number>;
  /** Array-valued analytics (audience, retention, activity breakdowns), kept as supplied after size checks. */
  breakdowns: Record<string, Breakdown>;
  missingFields: string[];
};
export type Breakdown = Array<Record<string, string | number | boolean | null> | number | string>;

const MAX_METRIC_KEYS = 200;
const MAX_BREAKDOWN_ITEMS = 100;
const MAX_BREAKDOWN_FIELDS = 20;
const METRIC_KEY = /^[A-Za-z0-9_.]{1,96}$/;
const TWITTER_EPOCH_MS = 1288834974657n;
/** Same bound as social_posts.platform_post_id (migration 0240); longer IDs are rejected, never truncated. */
export const MAX_POST_ID_LENGTH = 256;
/** Listed when the provider sent no metrics object at all for a post. */
export const ALL_METRICS_MISSING = 'metrics';

const feedPage = z.object({
  data: z.array(z.unknown()).max(100),
  meta: z.object({
    cursor: z.string().max(2048).nullable().optional(),
    has_more: z.boolean().optional(),
    next: z.string().max(4096).nullable().optional(),
  }).passthrough(),
}).passthrough();

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** X post IDs embed their creation time (public snowflake layout); used only when posted_at is absent. */
export function xSnowflakeTime(id: string): string | null {
  if (!/^\d{15,20}$/.test(id)) return null;
  const ms = (BigInt(id) >> 22n) + TWITTER_EPOCH_MS;
  const date = new Date(Number(ms));
  const year = date.getUTCFullYear();
  return year >= 2010 && year <= 2100 ? date.toISOString() : null;
}

/** Flattens nested provider metrics into dotted keys; only finite, non-negative numbers survive. */
function breakdown(value: unknown[]): Breakdown | null {
  if (value.length > MAX_BREAKDOWN_ITEMS) return null;
  const out: Breakdown = [];
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) { out.push(item); continue; }
    if (typeof item === 'string' && item.length <= 200) { out.push(item); continue; }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.length > MAX_BREAKDOWN_FIELDS) return null;
    const row: Record<string, string | number | boolean | null> = {};
    for (const [key, field] of entries) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) return null;
      if (field === null || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))
        || (typeof field === 'string' && field.length <= 200)) row[key] = field as string | number | boolean | null;
      else return null;
    }
    out.push(row);
  }
  return out;
}

export function flattenMetrics(raw: unknown): {
  metrics: Record<string, number>; breakdowns: Record<string, Breakdown>; missingFields: string[];
} {
  const metrics: Record<string, number> = {};
  const breakdowns: Record<string, Breakdown> = {};
  const missing: string[] = [];
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (Object.keys(metrics).length + Object.keys(breakdowns).length + missing.length >= MAX_METRIC_KEYS) return;
    // Deeper than we keep: the provider supplied something we do not store, so it is listed as missing.
    if (depth > 3) { if (prefix) missing.push(prefix); return; }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (METRIC_KEY.test(path)) walk(child, path, depth + 1);
      }
      return;
    }
    if (!prefix) return;
    if (Array.isArray(value)) {
      const kept = breakdown(value);
      if (kept) breakdowns[prefix] = kept; else missing.push(prefix);
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[prefix] = value;
    else missing.push(prefix);
  };
  walk(raw, '', 0);
  return { metrics, breakdowns, missingFields: missing.sort() };
}

function excerpt(caption: unknown): string | null {
  if (typeof caption !== 'string') return null;
  const clean = caption.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean ? [...clean].slice(0, 120).join('') : null;
}

// YouTube keeps the video title in platform_data.title; caption is the description there.
function postTitle(item: Record<string, unknown>, platform: string): string | null {
  if (platform === 'youtube' && item.platform_data && typeof item.platform_data === 'object') {
    const title = excerpt((item.platform_data as Record<string, unknown>).title);
    if (title) return title;
  }
  return excerpt(item.caption);
}

export function normalizePost(raw: unknown, platform: string): NormalizedPost | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = item.platform_post_id;
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_POST_ID_LENGTH) return null;
  let postedAt = isoTimestamp(item.posted_at);
  let postedAtSource: NormalizedPost['postedAtSource'] = postedAt ? 'provider' : null;
  if (!postedAt && platform === 'x') {
    postedAt = xSnowflakeTime(id);
    postedAtSource = postedAt ? 'x_snowflake' : null;
  }
  const flat = item.metrics === undefined || item.metrics === null
    ? { metrics: {}, breakdowns: {}, missingFields: [ALL_METRICS_MISSING] } : flattenMetrics(item.metrics);
  return { platformPostId: id, postedAt, postedAtSource, url: publicHttpsUrl(item.platform_url),
    titleExcerpt: postTitle(item, platform), ...flat };
}

export type FeedPage = { posts: NormalizedPost[]; rejected: number; nextCursor: string | null; hasMore: boolean };

/** Returns null when the envelope itself is not a feed page (treated as "not fetched", never as empty). */
export function normalizeFeedPage(json: unknown, platform: string): FeedPage | null {
  const parsed = feedPage.safeParse(json);
  if (!parsed.success) return null;
  const posts: NormalizedPost[] = [];
  let rejected = 0;
  for (const raw of parsed.data.data) {
    const post = normalizePost(raw, platform);
    if (post) posts.push(post); else rejected += 1;
  }
  // has_more is optional in the provider schema; when absent, a non-null next link means more pages.
  const meta = parsed.data.meta;
  const hasMore = meta.has_more ?? (typeof meta.next === 'string' && meta.next.length > 0);
  const nextCursor = hasMore ? meta.cursor ?? null : null;
  // Claiming more pages without a cursor to fetch them is inconsistent: not a trustworthy page.
  if (hasMore && nextCursor === null) return null;
  return { posts, rejected, nextCursor, hasMore };
}
