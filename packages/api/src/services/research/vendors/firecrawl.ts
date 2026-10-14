/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Firecrawl page-fetch adapter. The request is pinned so usage cannot exceed one credit per call
// (plan §3.5): markdown only, main content only, no JSON extraction (5x credits), no PDF parsing
// (`parsePDF: false` bills a PDF as one credit instead of one per page, even when an extensionless
// URL or a redirect lands on a PDF), a single page with no link following. Public pages only; no
// anti-bot or login options are ever requested. `proxy: 'basic'` pins one credit: the default `auto`
// retries hard targets through the 5-credit enhanced proxy.
import { clip, clipBytes, count, text, timestamp } from './fields';
import { lookup } from 'node:dns/promises';
import { exchange, mayHaveBilled, nonPublicHost, nonPublicIp, publicHttpUrl, usageUnits } from './http';
import type { ResearchCallResult, VendorDeps, VendorRequest } from './types';

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
export const FIRECRAWL_ROUTE = 'firecrawl:scrape:markdown';
/** Byte ceiling for page text handed to the model (plan §2.3). */
export const MAX_MARKDOWN_BYTES = 20_000;
const PAGE_FIELDS = ['title', 'publishedAt', 'language', 'markdown'] as const;


/** Public http(s) page without credentials; PDFs are refused before any request (they cost extra). */
export function buildFirecrawlRequest(rawUrl: string): { request: VendorRequest; url: string } | { reason: string } {
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { return { reason: 'INVALID_URL' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { reason: 'INVALID_URL' };
  if (url.username || url.password || nonPublicHost(url.hostname) || url.href.length > 2000) return { reason: 'INVALID_URL' };
  // Check the decoded path too: `report%2Epdf` is the same PDF once the origin decodes it.
  let decodedPath = url.pathname;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { return { reason: 'INVALID_URL' }; }
  if (/\.pdf$/i.test(url.pathname) || /\.pdf\s*$/i.test(decodedPath)) return { reason: 'PDF_NOT_SUPPORTED' };
  url.hash = '';
  return { url: url.href, request: { method: 'POST', url: FIRECRAWL_SCRAPE_URL, body: {
    url: url.href, formats: ['markdown'], onlyMainContent: true, parsePDF: false, proxy: 'basic',
  } } };
}

/**
 * Credits from the provider-owned top-level field only; absent or malformed → null (never 0).
 * `data.metadata` mixes in fields scraped from the target page, so a page could plant a fake
 * `creditsUsed` there; it is never trusted as a receipt. RT-7 confirms the real location.
 */
export function firecrawlCredits(json: unknown): string | null {
  const value = (json as { creditsUsed?: unknown } | null)?.creditsUsed;
  return value === undefined ? null : usageUnits(value);
}

const defaultResolve = async (hostname: string) => (await lookup(hostname, { all: true })).map(entry => entry.address);

/**
 * Pre-dispatch DNS check: a public-looking name that resolves to a private address (e.g. 127.0.0.1)
 * is refused before paying for it. Firecrawl resolves the name again on its own servers, so DNS
 * rebinding and redirects at the target cannot be ruled out from here; those land on Firecrawl's
 * network, and the returned page URL is re-checked before it is shown.
 */
async function resolvesPublic(hostname: string, deps: VendorDeps): Promise<boolean> {
  try {
    const addresses = await (deps.resolveHost ?? defaultResolve)(hostname);
    return addresses.length > 0 && addresses.every(address => !nonPublicIp(address));
  } catch {
    return false;
  }
}

export async function callFirecrawl(rawUrl: string, deps: VendorDeps): Promise<ResearchCallResult> {
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = { vendor: 'firecrawl' as const, route: FIRECRAWL_ROUTE, fetchedAt, items: [], truncated: false };
  const built = buildFirecrawlRequest(rawUrl);
  if ('reason' in built) {
    return { ...base, outcome: 'not_sent', reason: built.reason, httpStatus: null, supplierMayCharge: false,
      usage: { unit: 'credit', units: '0' } };
  }
  if (!(await resolvesPublic(new URL(built.url).hostname, deps))) {
    return { ...base, outcome: 'not_sent', reason: 'NON_PUBLIC_TARGET', httpStatus: null, supplierMayCharge: false,
      usage: { unit: 'credit', units: '0' } };
  }
  const answer = await exchange(built.request, { Authorization: `Bearer ${deps.apiKey}` }, deps);
  if (answer.kind === 'unknown') {
    return { ...base, outcome: 'unknown', reason: answer.reason, httpStatus: null, supplierMayCharge: true,
      usage: { unit: 'credit', units: null } };
  }
  // A 200 whose body cannot be read is indeterminate (possibly billed); other statuses are confirmed failures.
  if (answer.kind === 'unreadable') {
    return { ...base, outcome: answer.status >= 200 && answer.status < 300 ? 'unknown' : 'failed', reason: answer.reason, httpStatus: answer.status,
      supplierMayCharge: mayHaveBilled(answer.status, true), usage: { unit: 'credit', units: null } };
  }
  const json = answer.json as { success?: unknown } | null;
  if (answer.status !== 200 || json?.success !== true) {
    return { ...base, outcome: 'failed', reason: `HTTP_${answer.status}`, httpStatus: answer.status,
      supplierMayCharge: mayHaveBilled(answer.status, true), usage: { unit: 'credit', units: firecrawlCredits(answer.json) } };
  }
  const usage = { unit: 'credit' as const, units: firecrawlCredits(answer.json) };
  // Firecrawl bills target pages that answered 403/404; the user still gets no page.
  const targetStatus = count(answer.json, ['data.metadata.statusCode']);
  if (targetStatus !== undefined && targetStatus >= 400) {
    return { ...base, outcome: 'failed', reason: `TARGET_HTTP_${targetStatus}`, httpStatus: 200, supplierMayCharge: true, usage };
  }
  // A PDF comes back base64-encoded (parsePDF off) or as raw `%PDF-` bytes: billed once, but no page for the user.
  const contentType = text(answer.json, ['data.metadata.contentType', 'data.metadata.content-type']) ?? '';
  const markdown = text(answer.json, ['data.markdown']);
  if (/pdf/i.test(contentType) || /^(JVBERi0|%PDF-)/.test(markdown?.trimStart() ?? '')) {
    return { ...base, outcome: 'failed', reason: 'PDF_NOT_SUPPORTED', httpStatus: 200, supplierMayCharge: true, usage };
  }
  // No recognizable page body means nothing was delivered, whatever `success` says.
  if (markdown === undefined || markdown.trim() === '') {
    return { ...base, outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', httpStatus: 200, supplierMayCharge: true, usage };
  }
  const clipped = clipBytes(markdown, MAX_MARKDOWN_BYTES);
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
  // The reported page URL must pass the same public-URL guard; otherwise keep the URL we validated and sent.
  const pageUrl = publicHttpUrl(text(answer.json, ['data.metadata.sourceURL', 'data.metadata.url'])) ?? built.url;
  return { ...base, outcome: truncated ? 'partial' : 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
    usage, items: [{ url: pageUrl, fields, missing }], truncated };
}
