/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-4 (part a): benchmark categories, qualification and candidate selection
// (RESEARCH_TOOLS_PLAN.md §1, §1.2). The product thresholds are the server constants in BENCHMARK_RULES;
// only the "recent fast growth" N and K come from the admin config.
import { approximateRange } from '../vendors/approxCount';
import { BENCHMARK_RULES, type ResearchToolsConfig } from '../vendors/config';
import type { AccountMetrics, EvidenceItem } from './metrics';

const DAY_MS = 24 * 60 * 60 * 1000;

export type BenchmarkCategory = 'head_reference' | 'imitable' | 'fast_rising';
export type ExclusionReason =
  | 'FOLLOWERS_MISSING' | 'FOLLOWERS_BELOW_MIN' | 'NO_PUBLISH_TIME' | 'INACTIVE_30_DAYS' | 'NO_POSTS' | 'TOO_FEW_POSTS'
  | 'ACTIVE_CHECK_PENDING'
  /** Owner 2026-11-28 (H): the account plainly makes content off the confirmed niche (relevance.ts offTopic). */
  | 'OFF_TOPIC';

export type Classification =
  | { category: BenchmarkCategory; qualified: boolean; excluded: null }
  | { category: null; qualified: false; excluded: ExclusionReason };

/** Parses the admin K ("1.5") as a decimal; invalid text never qualifies anything. */
function ratio(text: string): number | null {
  return /^(0|[1-9]\d{0,3})(\.\d{1,4})?$/.test(text) ? Number(text) : null;
}

/**
 * Plan §1.2 step 4. Qualified = 10k–200k followers and an update within 30 days, from fetched data only
 * (a missing number never counts as meeting a threshold). Head references (> 200k) are shown, never qualified.
 * Fast rising is a subset of imitable: the earliest obtainable post is within N days, or the median views reach
 * followers × K.
 */
export function classifyAccount(
  metrics: AccountMetrics, growth: ResearchToolsConfig['recentGrowth'], now: Date,
  phase: 'discovery' | 'fetched' = 'fetched',
): Classification {
  const followers = metrics.followers.value;
  if (followers === null) return { category: null, qualified: false, excluded: 'FOLLOWERS_MISSING' };
  // A rounded YouTube count meets a threshold only when every exact count it may stand for does (Owner 2026-10-23, A).
  const { low, highExclusive } = metrics.followers.approximate ? approximateRange(followers) : { low: followers, highExclusive: followers + 1 };
  if (highExclusive - 1 < BENCHMARK_RULES.followersMin) return { category: null, qualified: false, excluded: 'FOLLOWERS_BELOW_MIN' };
  if (low > BENCHMARK_RULES.followersMax) return { category: 'head_reference', qualified: false, excluded: null };
  // Straddling a threshold, the exact count that decides it is unknown.
  if (low < BENCHMARK_RULES.followersMin || highExclusive - 1 > BENCHMARK_RULES.followersMax) {
    return { category: null, qualified: false, excluded: 'FOLLOWERS_MISSING' };
  }
  // Discovery screens followers only: posts and activity are checked once benchmark_fetch has read the account's own
  // newest posts. An account found by searching for accounts has no posts yet (BENCHMARK-COVERAGE), so posts cannot
  // decide anything here.
  if (phase === 'discovery') {
    return { category: null, qualified: false, excluded: 'ACTIVE_CHECK_PENDING' };
  }
  if (metrics.postsAnalyzed === 0) return { category: null, qualified: false, excluded: 'NO_POSTS' };
  if (metrics.lastPublishedAt.value === null) return { category: null, qualified: false, excluded: 'NO_PUBLISH_TIME' };
  const last = Date.parse(metrics.lastPublishedAt.value);
  if (now.getTime() - last > BENCHMARK_RULES.activeWithinDays * DAY_MS) {
    return { category: null, qualified: false, excluded: 'INACTIVE_30_DAYS' };
  }
  const earliest = metrics.earliestPublishedAt.value === null ? null : Date.parse(metrics.earliestPublishedAt.value);
  // Plan §1.2: the earliest obtainable post (the oldest fetched one) within N days.
  const young = earliest !== null && now.getTime() - earliest <= growth.maxFirstPostAgeDays * DAY_MS;
  const k = ratio(growth.minViewsToFollowers);
  // Against the largest count an approximate label may stand for, so every possible exact count meets the ratio.
  const viral = k !== null && metrics.medianViews.value !== null && metrics.medianViews.value >= (highExclusive - 1) * k;
  return { category: young || viral ? 'fast_rising' : 'imitable', qualified: true, excluded: null };
}

/**
 * A fetched benchmark (benchmark_fetch, not discovery screening) is qualified only with at least postsMin analyzed
 * posts, unless the supplier confirmed those are the account's whole history (a new account with fewer posts).
 * Owner 2026-10-16: "同意 RT-4b 作品条数选 A" (RESEARCH_TOOLS_PLAN §1.2 step 4).
 */
export function qualifyFetchedAccount(metrics: AccountMetrics, classification: Classification): Classification {
  if (!classification.qualified || metrics.postsAnalyzed >= BENCHMARK_RULES.postsMin || metrics.wholeHistory) return classification;
  return { category: null, qualified: false, excluded: 'TOO_FEW_POSTS' };
}

/**
 * An account whose content is plainly off the confirmed niche is neither a benchmark nor a head reference (Owner 2026-11-28, H:
 * "明显不相关的不进候选，或者至少不能判为合格"). An account already excluded keeps its own reason.
 */
export function excludeOffTopic(classification: Classification, offTopic: boolean): Classification {
  if (!offTopic || classification.excluded !== null) return classification;
  return { category: null, qualified: false, excluded: 'OFF_TOPIC' };
}

/**
 * How recent a discovery candidate's newest found post is (Owner 2026-11-28, "按 A 修"). The search sees only some of an account's
 * posts, so this orders and labels the candidate card and never excludes: older than the 30 days of INACTIVE_30_DAYS is "stale",
 * no dated post found (an account-search lead) is "unknown".
 */
export type SearchActivity = 'recent' | 'unknown' | 'stale';
export function searchActivity(metrics: AccountMetrics, now: Date): SearchActivity {
  const last = metrics.lastPublishedAt.value === null ? Number.NaN : Date.parse(metrics.lastPublishedAt.value);
  if (Number.isNaN(last)) return 'unknown';
  return now.getTime() - last > BENCHMARK_RULES.activeWithinDays * DAY_MS ? 'stale' : 'recent';
}
const ACTIVITY_RANK: Record<SearchActivity, number> = { recent: 0, unknown: 1, stale: 2 };

export interface ScoredAccount {
  key: string;
  metrics: AccountMetrics;
  classification: Classification;
}

/**
 * Candidate card contents (§1.2 step 5): selectable = qualified accounts, fast rising first, then by median
 * views; at most candidatesMax. Head references are listed separately and are never selectable. With fewer
 * than candidatesMin selectable accounts no card is sent (`enough: false`); the caller returns partial.
 * Given `now` (the card), candidates go by their newest found post first (Owner 2026-11-28, "按 A 修"): recent ones newest first,
 * then those with no dated post, then those older than 30 days, so a stale account is the first left off a full card.
 */
export function selectCandidates(accounts: ScoredAccount[], allowPendingActivity = false, now?: Date) {
  const views = (a: ScoredAccount) => a.metrics.medianViews.value ?? -1;
  const activity = (a: ScoredAccount) => (now ? ACTIVITY_RANK[searchActivity(a.metrics, now)] : 0);
  const newest = (a: ScoredAccount) => {
    const last = now && a.metrics.lastPublishedAt.value !== null ? Date.parse(a.metrics.lastPublishedAt.value) : Number.NaN;
    return Number.isNaN(last) ? 0 : last;
  };
  // One slot per account: the same account found by several keywords or a resumed discovery counts once.
  const distinct = [...new Map(accounts.map(a => [a.key, a] as const)).values()];
  const selectable = distinct.filter(a => a.classification.qualified
    || (allowPendingActivity && a.classification.excluded === 'ACTIVE_CHECK_PENDING'))
    .sort((a, b) => activity(a) - activity(b)
      || Number(b.classification.category === 'fast_rising') - Number(a.classification.category === 'fast_rising')
      || newest(b) - newest(a) || views(b) - views(a) || a.key.localeCompare(b.key))
    .slice(0, BENCHMARK_RULES.candidatesMax);
  const headReferences = distinct.filter(a => a.classification.category === 'head_reference');
  return { selectable, headReferences, enough: selectable.length >= BENCHMARK_RULES.candidatesMin };
}

/** Report gate input (§1.5): distinct qualified accounts; the gate itself lives with the RT-4 migration. */
export function qualifiedCount(accounts: ScoredAccount[]): number {
  return new Set(accounts.filter(a => a.classification.qualified).map(a => a.key)).size;
}

export interface AuthorCandidate {
  authorId: string;
  author: string | null;
  appearances: number;
  interactions: number;
  refs: string[];
}

/**
 * Discovery (§1.2 step 3): keyword-search posts grouped by author, ranked by how often the author appears and
 * then by reported interactions. Posts without an author id cannot be attributed and are skipped.
 */
export function aggregateAuthors(posts: EvidenceItem[], limit: number): AuthorCandidate[] {
  const authors = new Map<string, AuthorCandidate>();
  for (const post of posts) {
    const id = post.fields.authorId;
    if (typeof id !== 'string' || id.length === 0) continue;
    const entry = authors.get(id) ?? { authorId: id, author: null, appearances: 0, interactions: 0, refs: [] };
    entry.appearances += 1;
    if (entry.author === null && typeof post.fields.author === 'string') entry.author = post.fields.author;
    for (const field of ['likes', 'comments', 'shares']) {
      const value = post.fields[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) entry.interactions += value;
    }
    entry.refs.push(post.ref);
    authors.set(id, entry);
  }
  return [...authors.values()]
    .sort((a, b) => b.appearances - a.appearances || b.interactions - a.interactions || a.authorId.localeCompare(b.authorId))
    .slice(0, Math.max(0, limit));
}
