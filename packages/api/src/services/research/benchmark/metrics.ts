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
  /** The supplier said this list is the account's complete history (no further page). Unknown counts as false. */
  complete?: boolean;
  /**
   * The item carrying followers when it is not the profile (Bilibili relation, YouTube post detail). A YouTube
   * post detail is also the newest post's only absolute publication time, so it counts for recency.
   */
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
  /** Median of (likes + comments + shares) ÷ views over posts that report views and all three counters. */
  engagementRate: Metric;
  /** Posts published in the last 30 days × 7 ÷ 30. Missing unless every analyzed post has an absolute time. */
  postsPerWeek: Metric;
  lastPublishedAt: { value: string | null; refs: string[] };
  /** Earliest publication time among the fetched posts. */
  earliestPublishedAt: { value: string | null; refs: string[] };
  /** The supplier confirmed the fetched posts are the account's whole visible history (`complete`). */
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
    // A missing counter is never counted as zero: such a post does not enter the rate (Bilibili lacks likes/shares).
    const parts = ['likes', 'comments', 'shares'].map(field => num(post, field));
    if (views === 0 || parts.some(v => v === null)) continue;
    rates.push((parts as number[]).reduce((a, b) => a + b, 0) / views);
    rateRefs.push(post.ref);
  }

  const dated = posts.filter(post => time(post) !== null);
  const windowStart = now.getTime() - BENCHMARK_RULES.activeWithinDays * DAY_MS;
  const recent = dated.filter(post => time(post)! >= windowStart);
  // An undated post could fall inside the window, so a frequency from a partly dated list would treat it as
  // outside (as zero). Report it only when every analyzed post carries a time.
  // Unless the list is known to be complete, a page whose oldest post is still inside the window may hide further
  // posts (a capped page, or a cursor-paginated one): the frequency is unknown, not a low number.
  const capped = evidence.complete !== true && dated.length > 0 && time(dated[dated.length - 1]!)! >= windowStart;
  const frequencyKnown = posts.length > 0 && dated.length === posts.length && !capped;
  const detail = evidence.followersItem && time(evidence.followersItem) !== null ? evidence.followersItem : undefined;
  const newest = [dated[0], detail].filter((p): p is EvidenceItem => p !== undefined)
    .sort((a, b) => time(b)! - time(a)!)[0];
  const oldest = dated[dated.length - 1];

  const result: AccountMetrics = {
    followers: metric(followers, [followersSource.ref]),
    postsAnalyzed: posts.length,
    medianViews: metric(medianViews, viewed.map(post => post.ref)),
    engagementRate: metric(median(rates), rateRefs),
    // Refs: every dated post checked against the window, so a computed 0 carries its evidence too.
    postsPerWeek: metric(frequencyKnown ? (recent.length * 7) / BENCHMARK_RULES.activeWithinDays : null, dated.map(post => post.ref)),
    lastPublishedAt: newest ? { value: new Date(time(newest)!).toISOString(), refs: [newest.ref] } : { value: null, refs: [] },
    earliestPublishedAt: oldest ? { value: new Date(time(oldest)!).toISOString(), refs: [oldest.ref] } : { value: null, refs: [] },
    wholeHistory: evidence.complete === true,
    missing: [],
  };
  for (const key of ['followers', 'medianViews', 'engagementRate', 'postsPerWeek'] as const) {
    if (result[key].value === null) result.missing.push(key);
  }
  if (result.lastPublishedAt.value === null) result.missing.push('lastPublishedAt');
  return result;
}
