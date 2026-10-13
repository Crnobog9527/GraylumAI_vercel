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
  missingFields: string[];
};

const MAX_METRIC_KEYS = 200;
const METRIC_KEY = /^[A-Za-z0-9_.]{1,96}$/;
const TWITTER_EPOCH_MS = 1288834974657n;

const feedPage = z.object({
  data: z.array(z.unknown()).max(100),
  meta: z.object({
    cursor: z.string().max(2048).nullable().optional(),
    has_more: z.boolean().optional(),
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
export function flattenMetrics(raw: unknown): { metrics: Record<string, number>; missingFields: string[] } {
  const metrics: Record<string, number> = {};
  const missing: string[] = [];
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (Object.keys(metrics).length + missing.length >= MAX_METRIC_KEYS || depth > 3) return;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (METRIC_KEY.test(path)) walk(child, path, depth + 1);
      }
      return;
    }
    if (!prefix || Array.isArray(value)) return;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[prefix] = value;
    else missing.push(prefix);
  };
  walk(raw, '', 0);
  return { metrics, missingFields: missing.sort() };
}

function excerpt(caption: unknown): string | null {
  if (typeof caption !== 'string') return null;
  const clean = caption.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean ? [...clean].slice(0, 120).join('') : null;
}

export function normalizePost(raw: unknown, platform: string): NormalizedPost | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = item.platform_post_id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 256) return null;
  let postedAt = isoTimestamp(item.posted_at);
  let postedAtSource: NormalizedPost['postedAtSource'] = postedAt ? 'provider' : null;
  if (!postedAt && platform === 'x') {
    postedAt = xSnowflakeTime(id);
    postedAtSource = postedAt ? 'x_snowflake' : null;
  }
  const flat = item.metrics === undefined ? { metrics: {}, missingFields: [] } : flattenMetrics(item.metrics);
  return { platformPostId: id, postedAt, postedAtSource, url: publicHttpsUrl(item.platform_url),
    titleExcerpt: excerpt(item.caption), ...flat };
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
  const hasMore = parsed.data.meta.has_more === true;
  const nextCursor = hasMore ? parsed.data.meta.cursor ?? null : null;
  return { posts, rejected, nextCursor, hasMore: hasMore && nextCursor !== null };
}
