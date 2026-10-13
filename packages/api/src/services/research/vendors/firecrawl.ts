/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Firecrawl page-fetch adapter. The request is pinned so usage cannot exceed one credit per call
// (plan §3.5): markdown only, main content only, no JSON extraction (5x credits), no PDF parsing
// (extra credits per page), a single page with no link following. Public pages only; no anti-bot
// or login options are ever requested.
import { clip, count, text, timestamp } from './fields';
import { exchange, usageUnits } from './http';
import type { ResearchCallResult, VendorDeps, VendorRequest } from './types';

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
export const FIRECRAWL_ROUTE = 'firecrawl:scrape:markdown';
export const MAX_MARKDOWN_CHARS = 20_000;
const PAGE_FIELDS = ['title', 'publishedAt', 'language', 'markdown'] as const;

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return host.includes(':') && (host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80'));
}

/** Public http(s) page without credentials; PDFs are refused before any request (they cost extra). */
export function buildFirecrawlRequest(rawUrl: string): { request: VendorRequest; url: string } | { reason: string } {
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { return { reason: 'INVALID_URL' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { reason: 'INVALID_URL' };
  if (url.username || url.password || privateHost(url.hostname) || url.href.length > 2000) return { reason: 'INVALID_URL' };
  if (/\.pdf$/i.test(url.pathname)) return { reason: 'PDF_NOT_SUPPORTED' };
  url.hash = '';
  return { url: url.href, request: { method: 'POST', url: FIRECRAWL_SCRAPE_URL, body: {
    url: url.href, formats: ['markdown'], onlyMainContent: true,
  } } };
}

/** Credits from the documented locations; absent or malformed → null (never 0). */
export function firecrawlCredits(json: unknown): string | null {
  for (const path of ['creditsUsed', 'data.metadata.creditsUsed']) {
    const value = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | null)?.[key], json);
    if (value !== undefined) return usageUnits(value);
  }
  return null;
}

export async function callFirecrawl(rawUrl: string, deps: VendorDeps): Promise<ResearchCallResult> {
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = { vendor: 'firecrawl' as const, route: FIRECRAWL_ROUTE, fetchedAt, items: [], truncated: false };
  const built = buildFirecrawlRequest(rawUrl);
  if ('reason' in built) {
    return { ...base, outcome: 'not_sent', reason: built.reason, httpStatus: null, supplierMayCharge: false,
      usage: { unit: 'credit', units: '0' } };
  }
  const answer = await exchange(built.request, { Authorization: `Bearer ${deps.apiKey}` }, deps);
  if (answer.kind === 'unknown') {
    return { ...base, outcome: 'unknown', reason: answer.reason, httpStatus: null, supplierMayCharge: true,
      usage: { unit: 'credit', units: null } };
  }
  if (answer.kind === 'unreadable') {
    return { ...base, outcome: 'failed', reason: answer.reason, httpStatus: answer.status,
      supplierMayCharge: answer.status === 200, usage: { unit: 'credit', units: null } };
  }
  const json = answer.json as { success?: unknown } | null;
  if (answer.status !== 200 || json?.success !== true) {
    return { ...base, outcome: 'failed', reason: `HTTP_${answer.status}`, httpStatus: answer.status,
      supplierMayCharge: answer.status === 200, usage: { unit: 'credit', units: firecrawlCredits(answer.json) } };
  }
  const usage = { unit: 'credit' as const, units: firecrawlCredits(answer.json) };
  // Firecrawl bills target pages that answered 403/404; the user still gets no page.
  const targetStatus = count(answer.json, ['data.metadata.statusCode']);
  if (targetStatus !== undefined && targetStatus >= 400) {
    return { ...base, outcome: 'failed', reason: `TARGET_HTTP_${targetStatus}`, httpStatus: 200, supplierMayCharge: true, usage };
  }
  const markdown = text(answer.json, ['data.markdown']);
  const clipped = clip(markdown, MAX_MARKDOWN_CHARS);
  const values: Record<string, string | undefined> = {
    title: clip(text(answer.json, ['data.metadata.title', 'data.metadata.ogTitle']), 300),
    publishedAt: timestamp(answer.json, ['data.metadata.publishedTime', 'data.metadata.article:published_time']),
    language: text(answer.json, ['data.metadata.language']),
    markdown: clipped,
  };
  const fields: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of PAGE_FIELDS) {
    if (values[name] === undefined) missing.push(name);
    else fields[name] = values[name]!;
  }
  const truncated = markdown !== undefined && clipped !== markdown;
  const pageUrl = text(answer.json, ['data.metadata.sourceURL', 'data.metadata.url']) ?? built.url;
  return { ...base, outcome: truncated ? 'partial' : 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
    usage, items: [{ url: pageUrl, fields, missing }], truncated };
}
