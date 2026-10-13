/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Firecrawl page-fetch adapter. The request is pinned so usage cannot exceed one credit per call
// (plan §3.5): markdown only, main content only, no JSON extraction (5x credits), no PDF parsing
// (`parsePDF: false` bills a PDF as one credit instead of one per page, even when an extensionless
// URL or a redirect lands on a PDF), a single page with no link following. Public pages only; no
// anti-bot or login options are ever requested.
import { clip, count, text, timestamp } from './fields';
import { exchange, usageUnits } from './http';
import type { ResearchCallResult, VendorDeps, VendorRequest } from './types';

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
export const FIRECRAWL_ROUTE = 'firecrawl:scrape:markdown';
export const MAX_MARKDOWN_CHARS = 20_000;
const PAGE_FIELDS = ['title', 'publishedAt', 'language', 'markdown'] as const;

/** Non-public targets. IPv6 literals are refused outright (mapped, unspecified, ULA, link-local, ...). */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (!host.includes('.')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
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
    url: url.href, formats: ['markdown'], onlyMainContent: true, parsePDF: false,
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
  // A 200 whose body cannot be read is indeterminate (possibly billed); other statuses are confirmed failures.
  if (answer.kind === 'unreadable') {
    return { ...base, outcome: answer.status === 200 ? 'unknown' : 'failed', reason: answer.reason, httpStatus: answer.status,
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
  // With parsePDF off a PDF comes back base64-encoded: billed once, but there is no page to give the user.
  const contentType = text(answer.json, ['data.metadata.contentType', 'data.metadata.content-type']) ?? '';
  const markdown = text(answer.json, ['data.markdown']);
  if (/pdf/i.test(contentType) || markdown?.trimStart().startsWith('JVBERi0')) {
    return { ...base, outcome: 'failed', reason: 'PDF_NOT_SUPPORTED', httpStatus: 200, supplierMayCharge: true, usage };
  }
  // No recognizable page body means nothing was delivered, whatever `success` says.
  if (markdown === undefined || markdown.trim() === '') {
    return { ...base, outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', httpStatus: 200, supplierMayCharge: true, usage };
  }
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
