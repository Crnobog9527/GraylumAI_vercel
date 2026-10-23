/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Shared shapes for the RESEARCH-TOOLS supplier adapters (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md).
// Adapters only build requests and read responses; billing, evidence storage and runtime wiring
// live in later PRs (RT-2, RT-3).

export const RESEARCH_VENDORS = ['tikhub', 'parallel', 'firecrawl'] as const;
export type ResearchVendor = typeof RESEARCH_VENDORS[number];

export const SOCIAL_PLATFORMS = [
  'douyin', 'xiaohongshu', 'bilibili', 'weibo', 'tiktok', 'youtube', 'x', 'instagram',
] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];

/**
 * `account_relation` is a separate, separately billed follower lookup for platforms whose profile omits it (Bilibili).
 * `post_detail` reads one post by its id (YouTube: exact channel followers and an absolute publish date, RT-1b).
 * `account_search` finds accounts by keyword (BENCHMARK-COVERAGE): leads for the profile lookup, never benchmark data.
 */
export const SOCIAL_KINDS = ['keyword_posts', 'account_profile', 'account_posts', 'account_relation', 'post_detail',
  'account_search'] as const;
export type SocialKind = typeof SOCIAL_KINDS[number];

/** One whitelisted item. `missing` lists whitelisted fields the supplier did not provide. */
export interface ResearchItem {
  url?: string;
  fields: Record<string, string | number | boolean>;
  missing: string[];
}

/**
 * - ok / partial: data came back (partial = cut to the item or byte limit).
 * - failed: the supplier answered with a failure (confirmed; `supplierMayCharge` says whether
 *   the supplier documents charging for it, e.g. TikHub's HTTP 200 wrapping an upstream error).
 * - unknown: the request may have reached the supplier but no usable answer came back
 *   (timeout, disconnect, unreadable body). Never resend; RT-2/RT-3 decide how it settles.
 * - not_sent: rejected before any network call (bad input, unsupported route).
 */
export type ResearchOutcome = 'ok' | 'partial' | 'failed' | 'unknown' | 'not_sent';

/** Official usage as a decimal string; null when the supplier omitted or garbled it. */
export interface ResearchUsage {
  unit: 'call' | 'sku_search' | 'credit';
  units: string | null;
}

export interface ResearchCallResult {
  vendor: ResearchVendor;
  route: string;
  outcome: ResearchOutcome;
  reason: string | null;
  httpStatus: number | null;
  supplierMayCharge: boolean;
  usage: ResearchUsage;
  items: ResearchItem[];
  truncated: boolean;
  fetchedAt: string;
  /** Cursor of the next page when the supplier says more exist: an account's posts, or a keyword search (BENCHMARK-COVERAGE). */
  nextCursor?: string;
}

export interface VendorRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: Record<string, unknown>;
}

export interface VendorDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  /** DNS lookup for pre-dispatch target checks (Firecrawl); defaults to node:dns. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}
