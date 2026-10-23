/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-1b (docs/launch/implementation/BENCHMARK_COVERAGE_PLAN.md §3, Owner 2026-10-23 "1 选 A"): when the
// first page of every keyword and every author on it still leave fewer than candidatesMin selectable accounts, a
// discovery searches deeper before it may call the round short: accounts found by searching for them (where the
// platform has an account search route), then pages 2–3 of the keywords whose previous page brought new authors. Each
// discovery has a per-platform ceiling on paid lookups, priced by tier; the coverage it reached is reported so the coach
// can say what was searched instead of guessing.
import type { EvidenceItem } from '../benchmark/metrics';
import type { ResearchItem, SocialPlatform } from '../vendors/types';
import type { DiscoveryRecord } from './store';
import type { SupplierRequest } from './subcall';
import { socialRequest, type ResearchToolContext } from './toolContext';

/** Platforms whose keyword search costs 0.01 USD a call (Owner A: half the ceiling of the 0.001 USD platforms). */
const PRICEY = new Set<SocialPlatform>(['douyin', 'xiaohongshu']);
/** Pages after the first, per keyword and in total per platform (plan §4.1: 24 searches with 10 keywords). */
const MAX_PAGE = 3;
const MAX_EXTRA_PAGES = 14;
/** A page brings "new authors" when at least this many were not seen on earlier pages (plan §2.2). */
const FRESH_AUTHORS = 3;

/**
 * Paid lookups one discovery may spend per platform: 80 on a 0.001 USD platform, 40 on a 0.01 USD one; with two
 * platforms the round's whole ceiling stays the same and is split evenly (plan §4.1).
 */
export function discoveryCap(platform: SocialPlatform, platforms: number): number {
  const cap = PRICEY.has(platform) ? 40 : 80;
  return platforms > 1 ? cap / 2 : cap;
}

export interface PlatformCoverage {
  spent: { searches: number; pages: number; accountSearches: number; profiles: number };
  capReached: boolean;
  /** Every layer this platform supports was searched to its end (not stopped by the ceiling or this reply's allowance). */
  exhausted: boolean;
}
export interface DiscoveryCoverage { keywords: number; platforms: Partial<Record<SocialPlatform, PlatformCoverage>> }

export function discoveryCoverage(platforms: SocialPlatform[], keywords: number): DiscoveryCoverage {
  return { keywords, platforms: Object.fromEntries(platforms.map(platform => [platform,
    { spent: { searches: 0, pages: 0, accountSearches: 0, profiles: 0 }, capReached: false, exhausted: false }])) };
}

export const total = (coverage: PlatformCoverage) => Object.values(coverage.spent).reduce((sum, value) => sum + value, 0);

interface Step { items: ResearchItem[]; operationId: string; stopped: boolean; nextCursor?: string }
export interface DeepenInput {
  ctx: ResearchToolContext;
  d: DiscoveryRecord;
  posts: Map<SocialPlatform, EvidenceItem[]>;
  /** Per `${platform}\n${keyword}`: the first page's next cursor and how many authors it added. */
  firstPages: Map<string, { cursor?: string; fresh: number }>;
  coverage: DiscoveryCoverage;
  pay: (platform: SocialPlatform, request: SupplierRequest, kind: keyof PlatformCoverage['spent']) => Promise<Step | null>;
  screen: (platform: SocialPlatform, authorId: string, label: string | null, authorPosts: EvidenceItem[]) => Promise<void>;
  /** A full card (candidatesMax selectable): the deeper layers stop there. */
  enough: () => boolean;
  isStopped: () => boolean;
}

/** Layers 2 and 3. Returns when a card can be shown, the reply's allowance stopped it, or every layer ran out. */
export async function deepen(input: DeepenInput): Promise<void> {
  const { ctx, d, posts, coverage, pay, screen, enough, isStopped } = input;
  const done = () => isStopped() || enough();
  for (const platform of d.platforms) {
    const cover = coverage.platforms[platform]!;
    // Layer 2: search for accounts with each keyword; the leads are screened like authors (no posts of theirs yet).
    if (socialRequest(ctx, platform, 'account_search', { keyword: d.keywords[0] })) {
      for (const keyword of d.keywords) {
        if (done()) return;
        const result = await pay(platform, socialRequest(ctx, platform, 'account_search', { keyword })!, 'accountSearches');
        if (!result || isStopped()) break;
        for (const lead of result.items) {
          if (done()) return;
          if (typeof lead.fields.id === 'string') {
            await screen(platform, lead.fields.id, typeof lead.fields.name === 'string' ? lead.fields.name : null, []);
          }
        }
      }
    }
    if (done()) return;
    // Layer 3: next pages, round by round, only of keywords whose last page still brought new authors.
    const entries = posts.get(platform) ?? [];
    let pages = d.keywords.map(keyword => ({ keyword, ...(input.firstPages.get(`${platform}\n${keyword}`) ?? { fresh: 0 }) }));
    for (let page = 2; page <= MAX_PAGE; page++) {
      const next: typeof pages = [];
      for (const { keyword, cursor, fresh } of pages) {
        if (done()) return;
        if (!cursor || fresh < FRESH_AUTHORS || cover.spent.pages >= MAX_EXTRA_PAGES) continue;
        const result = await pay(platform, socialRequest(ctx, platform, 'keyword_posts', { keyword, cursor })!, 'pages');
        if (!result || isStopped()) break;
        const seen = new Set(entries.map(post => post.fields.authorId));
        const found: EvidenceItem[] = result.items.map((item, i) => ({ ...item, ref: `${result.operationId}#${i + 1}` }));
        entries.push(...found);
        const newcomers = [...new Set(found.map(post => post.fields.authorId)
          .filter((id): id is string => typeof id === 'string' && !seen.has(id)))];
        next.push({ keyword, cursor: result.nextCursor, fresh: newcomers.length });
        for (const authorId of newcomers) {
          if (done()) return;
          const own = entries.filter(post => post.fields.authorId === authorId);
          const label = own.map(post => post.fields.author).find((name): name is string => typeof name === 'string') ?? null;
          await screen(platform, authorId, label, own);
        }
      }
      pages = next;
    }
    cover.exhausted = !cover.capReached && !isStopped();
  }
}
