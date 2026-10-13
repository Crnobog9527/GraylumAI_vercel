/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Parallel web-search adapter. The request matches the RESEARCH-0 shape (#466): one objective, one
// query, a fixed mode. Only keywords leave Graylum (plan §4.2); results are for this user only and
// are never cached for another user (Parallel customer terms §2(b)).
import { clip, list, text, timestamp } from './fields';
import { exchange, usageUnits } from './http';
import type { ResearchCallResult, ResearchItem, VendorDeps, VendorRequest } from './types';

export const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';
/** Only the mode RESEARCH-0 tested; other modes stay out until RT-7 measures them. */
export const PARALLEL_MODES = ['advanced'] as const;
export type ParallelMode = typeof PARALLEL_MODES[number];
export const PARALLEL_ROUTE = 'parallel:search:advanced';
const MAX_RESULTS = 10;
const EXCERPT_CHARS = 500;
const WEB_FIELDS = ['title', 'excerpt', 'publishedAt'] as const;

export function buildParallelRequest(query: string, mode: ParallelMode = 'advanced'): { request: VendorRequest } | { reason: string } {
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

/** A result link the user can open: trimmed, absolute http(s), no credentials. */
function publicHttpUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
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

export async function callParallel(query: string, deps: VendorDeps, mode: ParallelMode = 'advanced'): Promise<ResearchCallResult> {
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = { vendor: 'parallel' as const, route: PARALLEL_ROUTE, fetchedAt, items: [], truncated: false };
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
    return { ...base, outcome: answer.status === 200 ? 'unknown' : 'failed', reason: answer.reason, httpStatus: answer.status,
      supplierMayCharge: answer.status === 200, usage: { unit: 'sku_search', units: null } };
  }
  const results = (answer.json as { results?: unknown } | null)?.results;
  if (answer.status !== 200 || !Array.isArray(results)) {
    return { ...base, outcome: 'failed', reason: `HTTP_${answer.status}`, httpStatus: answer.status,
      supplierMayCharge: answer.status === 200, usage: { unit: 'sku_search', units: parallelUsage(answer.json) } };
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
