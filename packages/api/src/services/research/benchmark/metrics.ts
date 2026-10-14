/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-4 (part a): benchmark numbers computed by code from fetched evidence only
// (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §1.2–§1.4). The model never supplies these numbers;
// a missing field stays missing, never 0. Pure functions: storage, the benchmark table and the report gate
// arrive with the RT-4 migration.
import { BENCHMARK_RULES } from '../vendors/config';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One fetched item as RT-3 stores it: whitelisted fields plus the evidence ref (`e1#3`) it came from. */
export interface EvidenceItem {
  ref: string;
  fields: Record<string, string | number | boolean>;
  missing: string[];
}

export interface AccountEvidence {
  profile: EvidenceItem;
  /** Account posts, any order. Only the newest `postsMax` are used. */
  posts: EvidenceItem[];
  /** Ref of the item carrying followers when it is not the profile (Bilibili relation, YouTube post detail). */
  followersItem?: EvidenceItem;
}

/** A number with the evidence refs it was computed from; null when the evidence cannot support it. */
export interface Metric {
  value: number | null;
  refs: string[];
}

export interface AccountMetrics {
  followers: Metric;
  postsAnalyzed: number;
  medianViews: Metric;
  /** Median of (likes + comments + shares that the platform reports) ÷ views, per post with views. */
  engagementRate: Metric;
  /** Posts published in the last 30 days × 7 ÷ 30. Needs absolute publication times. */
  postsPerWeek: Metric;
  lastPublishedAt: { value: string | null; refs: string[] };
  /** Earliest publication time among the fetched posts. */
  earliestPublishedAt: { value: string | null; refs: string[] };
  /** Fewer than postsMax posts came back, so the fetched posts are the account's whole visible history. */
  wholeHistory: boolean;
  missing: string[];
}

const num = (item: EvidenceItem, field: string): number | null => {
  const value = item.fields[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};
/** Allowed clock skew; a publication time further in the future is bad data and counts as missing. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const timeAt = (now: number) => (item: EvidenceItem): number | null => {
  const value = item.fields.publishedAt;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= now + FUTURE_SKEW_MS ? ms : null;
};
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const metric = (value: number | null, refs: string[]): Metric => (value === null ? { value: null, refs: [] } : { value, refs });

/**
 * The newest `postsMax` posts by publication time; posts without a time keep their supplier order after
 * the dated ones (they still count for views and engagement, never for recency).
 */
function newestPosts(posts: EvidenceItem[], time: (item: EvidenceItem) => number | null): EvidenceItem[] {
  const dated = posts.filter(post => time(post) !== null).sort((a, b) => time(b)! - time(a)!);
  const undated = posts.filter(post => time(post) === null);
  return [...dated, ...undated].slice(0, BENCHMARK_RULES.postsMax);
}

export function accountMetrics(evidence: AccountEvidence, now: Date): AccountMetrics {
  const time = timeAt(now.getTime());
  const posts = newestPosts(evidence.posts, time);
  const followersSource = evidence.followersItem ?? evidence.profile;
  const followers = num(followersSource, 'followers');

  const viewed = posts.filter(post => num(post, 'views') !== null);
  const medianViews = median(viewed.map(post => num(post, 'views')!));

  const rates: number[] = [];
  const rateRefs: string[] = [];
  for (const post of viewed) {
    const views = num(post, 'views')!;
    const parts = ['likes', 'comments', 'shares'].map(field => num(post, field)).filter((v): v is number => v !== null);
    if (views === 0 || parts.length === 0) continue;
    rates.push(parts.reduce((a, b) => a + b, 0) / views);
    rateRefs.push(post.ref);
  }

  const dated = posts.filter(post => time(post) !== null);
  const windowStart = now.getTime() - BENCHMARK_RULES.activeWithinDays * DAY_MS;
  const recent = dated.filter(post => time(post)! >= windowStart);
  const newest = dated[0];
  const oldest = dated[dated.length - 1];

  const result: AccountMetrics = {
    followers: metric(followers, [followersSource.ref]),
    postsAnalyzed: posts.length,
    medianViews: metric(medianViews, viewed.map(post => post.ref)),
    engagementRate: metric(median(rates), rateRefs),
    postsPerWeek: metric(dated.length ? (recent.length * 7) / BENCHMARK_RULES.activeWithinDays : null, recent.map(post => post.ref)),
    lastPublishedAt: newest ? { value: new Date(time(newest)!).toISOString(), refs: [newest.ref] } : { value: null, refs: [] },
    earliestPublishedAt: oldest ? { value: new Date(time(oldest)!).toISOString(), refs: [oldest.ref] } : { value: null, refs: [] },
    wholeHistory: evidence.posts.length < BENCHMARK_RULES.postsMax,
    missing: [],
  };
  for (const key of ['followers', 'medianViews', 'engagementRate', 'postsPerWeek'] as const) {
    if (result[key].value === null) result.missing.push(key);
  }
  if (result.lastPublishedAt.value === null) result.missing.push('lastPublishedAt');
  return result;
}
