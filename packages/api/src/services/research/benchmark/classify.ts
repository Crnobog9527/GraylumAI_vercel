/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-4 (part a): benchmark categories, qualification and candidate selection
// (RESEARCH_TOOLS_PLAN.md §1, §1.2). The product thresholds are the server constants in BENCHMARK_RULES;
// only the "recent fast growth" N and K come from the admin config.
import { BENCHMARK_RULES, type ResearchToolsConfig } from '../vendors/config';
import type { AccountMetrics, EvidenceItem } from './metrics';

const DAY_MS = 24 * 60 * 60 * 1000;

export type BenchmarkCategory = 'head_reference' | 'imitable' | 'fast_rising';
export type ExclusionReason =
  | 'FOLLOWERS_MISSING' | 'FOLLOWERS_BELOW_MIN' | 'NO_PUBLISH_TIME' | 'INACTIVE_30_DAYS' | 'NO_POSTS';

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
): Classification {
  const followers = metrics.followers.value;
  if (followers === null) return { category: null, qualified: false, excluded: 'FOLLOWERS_MISSING' };
  if (followers < BENCHMARK_RULES.followersMin) return { category: null, qualified: false, excluded: 'FOLLOWERS_BELOW_MIN' };
  if (followers > BENCHMARK_RULES.followersMax) return { category: 'head_reference', qualified: false, excluded: null };
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
  const viral = k !== null && metrics.medianViews.value !== null && metrics.medianViews.value >= followers * k;
  return { category: young || viral ? 'fast_rising' : 'imitable', qualified: true, excluded: null };
}

export interface ScoredAccount {
  key: string;
  metrics: AccountMetrics;
  classification: Classification;
}

/**
 * Candidate card contents (§1.2 step 5): selectable = qualified accounts, fast rising first, then by median
 * views; at most candidatesMax. Head references are listed separately and are never selectable. With fewer
 * than candidatesMin selectable accounts no card is sent (`enough: false`); the caller returns partial.
 */
export function selectCandidates(accounts: ScoredAccount[]) {
  const views = (a: ScoredAccount) => a.metrics.medianViews.value ?? -1;
  // One slot per account: the same account found by several keywords or a resumed discovery counts once.
  const distinct = [...new Map(accounts.map(a => [a.key, a] as const)).values()];
  const selectable = distinct.filter(a => a.classification.qualified)
    .sort((a, b) => Number(b.classification.category === 'fast_rising') - Number(a.classification.category === 'fast_rising')
      || views(b) - views(a) || a.key.localeCompare(b.key))
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
