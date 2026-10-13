/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Parallel web-search adapter. The request matches the RESEARCH-0 shape (#466): one objective, one
// query, a fixed mode. Only keywords leave Graylum (plan §4.2); results are for this user only and
// are never cached for another user (Parallel customer terms §2(b)).
import { clip, list, text, timestamp } from './fields';
import { exchange, mayHaveBilled, publicHttpUrl, usageUnits } from './http';
import type { ResearchCallResult, ResearchItem, VendorDeps, VendorRequest } from './types';

export const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';
/**
 * Upstream modes from Parallel's API reference: `fast` is the default for the planned `web_search` tool,
 * the model-facing `pro` choice maps to `advanced` (what RESEARCH-0 tested). RT-7 measures `fast`.
 * Each mode is its own priced route.
 */
export const PARALLEL_MODES = ['fast', 'advanced'] as const;
export type ParallelMode = typeof PARALLEL_MODES[number];
export const parallelRoute = (mode: ParallelMode) => `parallel:search:${mode}`;
/** Model-facing tool choice → upstream mode. */
export function parallelModeFor(choice: 'fast' | 'pro'): ParallelMode {
  return choice === 'pro' ? 'advanced' : 'fast';
}
const MAX_RESULTS = 10;
const EXCERPT_CHARS = 500;
const WEB_FIELDS = ['title', 'excerpt', 'publishedAt'] as const;

export function buildParallelRequest(query: string, mode: ParallelMode = 'fast'): { request: VendorRequest } | { reason: string } {
  const trimmed = query.trim();
  if (!trimmed || [...trimmed].length > 200 || /\p{Cc}/u.test(trimmed)) return { reason: 'INVALID_QUERY' };
  if (!PARALLEL_MODES.includes(mode)) return { reason: 'MODE_NOT_SUPPORTED' };
  return { request: { method: 'POST', url: PARALLEL_SEARCH_URL, body: {
    objective: `Find recent, reliable web pages about: ${trimmed}`, search_queries: [trimmed], mode,
  } } };
}

/** `usage: [{name:'sku_search', count:1}]` → "1"; absent or malformed → null (never 0). */
export function parallelUsage(json: unknown): string | null {
  const usage = (json as { usage?: unknown } | null)?.usage;
  if (!Array.isArray(usage)) return null;
  const entries = usage.filter(item => (item as { name?: unknown })?.name === 'sku_search');
  if (entries.length !== 1) return null;
  return usageUnits((entries[0] as { count?: unknown }).count);
}


function webItem(raw: unknown): ResearchItem {
  const values: Record<string, string | undefined> = {
    title: clip(text(raw, ['title']), 300),
    excerpt: clip(text(raw, ['excerpts.0']), EXCERPT_CHARS),
    publishedAt: timestamp(raw, ['publish_date']),
  };
  const fields: ResearchItem['fields'] = {};
  const missing: string[] = [];
  for (const name of WEB_FIELDS) {
    if (values[name] === undefined) missing.push(name);
    else fields[name] = values[name]!;
  }
  const url = publicHttpUrl(text(raw, ['url']));
  return url === undefined ? { fields, missing } : { url, fields, missing };
}

export async function callParallel(query: string, deps: VendorDeps, mode: ParallelMode = 'fast'): Promise<ResearchCallResult> {
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = { vendor: 'parallel' as const, route: parallelRoute(mode), fetchedAt, items: [], truncated: false };
  const built = buildParallelRequest(query, mode);
  if ('reason' in built) {
    return { ...base, outcome: 'not_sent', reason: built.reason, httpStatus: null, supplierMayCharge: false,
      usage: { unit: 'sku_search', units: '0' } };
  }
  const answer = await exchange(built.request, { 'x-api-key': deps.apiKey }, deps);
  if (answer.kind === 'unknown') {
    return { ...base, outcome: 'unknown', reason: answer.reason, httpStatus: null, supplierMayCharge: true,
      usage: { unit: 'sku_search', units: null } };
  }
  // A 200 whose body cannot be read is indeterminate (possibly billed); other statuses are confirmed failures.
  if (answer.kind === 'unreadable') {
    return { ...base, outcome: answer.status >= 200 && answer.status < 300 ? 'unknown' : 'failed', reason: answer.reason, httpStatus: answer.status,
      supplierMayCharge: mayHaveBilled(answer.status, true), usage: { unit: 'sku_search', units: null } };
  }
  const results = (answer.json as { results?: unknown } | null)?.results;
  if (answer.status !== 200 || !Array.isArray(results)) {
    return { ...base, outcome: 'failed', reason: `HTTP_${answer.status}`, httpStatus: answer.status,
      supplierMayCharge: mayHaveBilled(answer.status, true), usage: { unit: 'sku_search', units: parallelUsage(answer.json) } };
  }
  const usage = { unit: 'sku_search' as const, units: parallelUsage(answer.json) };
  if (results.length === 0) return { ...base, outcome: 'ok', reason: 'NO_RESULTS', httpStatus: 200, supplierMayCharge: true, usage };
  // Entries without a URL are not usable results; a non-empty set with none usable is a changed shape, not a delivery.
  const all = list(answer.json, ['results']).map(webItem).filter(item => item.url !== undefined);
  if (all.length === 0) {
    return { ...base, outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', httpStatus: 200, supplierMayCharge: true, usage };
  }
  const items = all.slice(0, MAX_RESULTS);
  return { ...base, outcome: all.length > MAX_RESULTS ? 'partial' : 'ok', reason: null, httpStatus: 200,
    supplierMayCharge: true, usage, items,
    truncated: all.length > MAX_RESULTS };
}
