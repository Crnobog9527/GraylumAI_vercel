/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-1b (docs/launch/implementation/BENCHMARK_COVERAGE_PLAN.md §3, Owner 2026-10-23 "1 选 A"): when the
// first page of every keyword and every author on it still leave fewer than candidatesMax selectable accounts, a
// discovery searches deeper before it may call the round short: accounts found by searching for them (where the
// platform has an account search route), then pages 2–3 of the keywords whose previous page brought new authors, then
// web pages that list the niche's creators (Parallel, PR-4: the links' accounts are screened like authors). Each
// discovery has a per-platform ceiling on paid lookups, priced by tier; the coverage it reached is reported so the coach
// can say what was searched instead of guessing.
import type { EvidenceItem } from '../benchmark/metrics';
import type { ResearchItem, SocialPlatform } from '../vendors/types';
import type { DiscoveryRecord } from './store';
import type { SupplierRequest } from './subcall';
import { canonicalAccount, parseProfileLink } from '../tools/accountLinks';
import { selectRoute } from '../vendors/config';
import { socialRequest, type ResearchToolContext } from './toolContext';

/** Platforms whose keyword search costs 0.01 USD a call (Owner A: half the ceiling of the 0.001 USD platforms). */
const PRICEY = new Set<SocialPlatform>(['douyin', 'xiaohongshu']);
/** Pages after the first, per keyword and in total per platform (plan §4.1: 24 searches with 10 keywords). */
const MAX_PAGE = 3;
const MAX_EXTRA_PAGES = 14;
/** A page brings "new authors" when at least this many were not seen on earlier pages (plan §2.2). */
const FRESH_AUTHORS = 3;
/** Layer 4: web searches per platform, one per keyword, for pages that list the niche's creators (plan §2.4). */
const WEB_QUERIES = 2;
const PLATFORM_NAMES: Partial<Record<SocialPlatform, string>> = {
  tiktok: 'TikTok', youtube: 'YouTube', x: 'X Twitter', xiaohongshu: '小红书', douyin: '抖音', bilibili: 'B站', instagram: 'Instagram',
};
const LINK = /https?:\/\/[^\s"'<>()\]]+/g;

/**
 * Accounts on `platform` named by one web result: its own link and the links in its title and excerpt. Profile links
 * only (as pasted links are read), plus TikTok video links, which carry the author's handle. Code-extracted, never
 * model-written; YouTube @handle links are skipped (no handle → channel route).
 */
export function webLeads(item: ResearchItem, platform: SocialPlatform): string[] {
  const links = [item.url, ...[item.fields.title, item.fields.excerpt].flatMap(value => (typeof value === 'string'
    ? value.match(LINK) ?? [] : []))].filter((link): link is string => typeof link === 'string');
  const leads = links.map(link => {
    const profile = parseProfileLink(link);
    if (profile) return profile.platform === platform ? profile.account : null;
    if (platform !== 'tiktok') return null;
    const video = link.match(/^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([^/?#]+)\/video\/\d+/i);
    return video ? canonicalAccount('tiktok', video[1]!) : null;
  });
  return [...new Set(leads.filter((lead): lead is string => lead !== null))];
}

/**
 * Paid lookups one discovery may spend per platform: 80 on a 0.001 USD platform, 40 on a 0.01 USD one; with two
 * platforms the round's whole ceiling stays the same and is split evenly (plan §4.1).
 */
export function discoveryCap(platform: SocialPlatform, platforms: number): number {
  const cap = PRICEY.has(platform) ? 40 : 80;
  return platforms > 1 ? cap / 2 : cap;
}

export interface PlatformCoverage {
  spent: { searches: number; pages: number; accountSearches: number; webSearches: number; profiles: number };
  capReached: boolean;
  /** Every layer this platform supports was searched to its end (not stopped by the ceiling or this reply's allowance). */
  exhausted: boolean;
}
export interface DiscoveryCoverage { keywords: number; platforms: Partial<Record<SocialPlatform, PlatformCoverage>> }

export function discoveryCoverage(platforms: SocialPlatform[], keywords: number): DiscoveryCoverage {
  return { keywords, platforms: Object.fromEntries(platforms.map(platform => [platform,
    { spent: { searches: 0, pages: 0, accountSearches: 0, webSearches: 0, profiles: 0 }, capReached: false, exhausted: false }])) };
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
  /** A card can show (candidatesMin selectable): the speculative web layer only runs while it cannot. */
  cardable: () => boolean;
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
    if (done()) return;
    // Layer 4: web pages that list this niche's creators; the accounts their links name are leads like any other.
    // Only while the round would otherwise end without a card: it is the lowest-yield layer, so a card of 8–11 does not
    // pay for it.
    const web = selectRoute(ctx.config, 'web', 'web_search');
    if (web.ok && web.vendor === 'parallel' && !input.cardable()) {
      for (const keyword of d.keywords.slice(0, WEB_QUERIES)) {
        if (done()) return;
        const query = `${keyword} ${PLATFORM_NAMES[platform] ?? platform} creators`;
        const result = await pay(platform, { vendor: 'parallel', route: web.route, query, mode: 'fast' }, 'webSearches');
        if (!result || isStopped()) break;
        for (const lead of result.items.flatMap(item => webLeads(item, platform))) {
          if (done() || input.cardable()) return;
          await screen(platform, lead, null, []);
        }
      }
    }
    cover.exhausted = !cover.capReached && !isStopped();
  }
}
