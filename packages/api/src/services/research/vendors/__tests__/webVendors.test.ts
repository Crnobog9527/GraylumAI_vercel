/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Parallel and Firecrawl adapters against fetch doubles; response shapes follow RESEARCH-0 (#466, #465).
import { describe, expect, it } from 'vitest';
import { buildParallelRequest, callParallel, parallelUsage } from '../parallel';
import { buildFirecrawlRequest, callFirecrawl, firecrawlCredits, MAX_MARKDOWN_CHARS } from '../firecrawl';
import { usageUnits } from '../http';
import { FIXED_NOW, hangingFetch, jsonFetch, type RecordedCall } from './fetchDoubles';

const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });

describe('official usage parsing', () => {
  it('accepts non-negative decimals and rejects everything else', () => {
    expect(usageUnits(1)).toBe('1');
    expect(usageUnits('2.5')).toBe('2.5');
    expect(usageUnits(0)).toBe('0');
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e21, '1e3', ' 1', '-0', null, undefined, {}]) {
      expect(usageUnits(bad)).toBeNull();
    }
  });

  it('reads Parallel sku_search exactly once and never as zero when absent', () => {
    expect(parallelUsage({ usage: [{ name: 'sku_search', count: 1 }] })).toBe('1');
    expect(parallelUsage({ usage: [] })).toBeNull();
    expect(parallelUsage({})).toBeNull();
    expect(parallelUsage({ usage: [{ name: 'sku_search', count: 1 }, { name: 'sku_search', count: 1 }] })).toBeNull();
    expect(parallelUsage({ usage: [{ name: 'sku_search', count: -1 }] })).toBeNull();
  });

  it('reads Firecrawl credits from either documented location', () => {
    expect(firecrawlCredits({ creditsUsed: 1 })).toBe('1');
    expect(firecrawlCredits({ data: { metadata: { creditsUsed: 1 } } })).toBe('1');
    expect(firecrawlCredits({ data: {} })).toBeNull();
  });
});

describe('callParallel', () => {
  it('sends only the keyword query in the tested shape', async () => {
    const calls: RecordedCall[] = [];
    const body = { results: [{ url: 'https://a.example/x', title: 'A', excerpts: ['摘要'], publish_date: '2026-09-01' }],
      usage: [{ name: 'sku_search', count: 1 }] };
    const result = await callParallel('露营装备 推荐', deps(jsonFetch(200, body, calls)));
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      objective: 'Find recent, reliable web pages about: 露营装备 推荐', search_queries: ['露营装备 推荐'], mode: 'advanced',
    });
    expect(calls[0].init.headers).toMatchObject({ 'x-api-key': 'test-key' });
    expect(result).toMatchObject({ outcome: 'ok', usage: { unit: 'sku_search', units: '1' } });
    expect(result.items[0]).toEqual({ url: 'https://a.example/x',
      fields: { title: 'A', excerpt: '摘要', publishedAt: '2026-09-01T00:00:00.000Z' }, missing: [] });
  });

  it('keeps a missing usage field as null on a successful answer', async () => {
    const result = await callParallel('q', deps(jsonFetch(200, { results: [{ url: 'https://a.example', title: 'A' }] })));
    expect(result).toMatchObject({ outcome: 'ok', usage: { units: null } });
    expect(result.items[0].missing).toEqual(['excerpt', 'publishedAt']);
  });

  it('refuses empty, overlong or unsupported-mode queries without sending', async () => {
    expect(buildParallelRequest(' ')).toEqual({ reason: 'INVALID_QUERY' });
    expect(buildParallelRequest('a'.repeat(201))).toEqual({ reason: 'INVALID_QUERY' });
    expect(buildParallelRequest('q', 'fast' as never)).toEqual({ reason: 'MODE_NOT_SUPPORTED' });
  });

  it('classifies HTTP errors and timeouts', async () => {
    expect(await callParallel('q', deps(jsonFetch(401, { error: 'bad key' }))))
      .toMatchObject({ outcome: 'failed', reason: 'HTTP_401', supplierMayCharge: false });
    expect(await callParallel('q', deps(hangingFetch()))).toMatchObject({ outcome: 'unknown', reason: 'TIMEOUT', usage: { units: null } });
    expect(await callParallel('q', deps(jsonFetch(200, 'not json'))))
      .toMatchObject({ outcome: 'failed', reason: 'RESPONSE_NOT_JSON', supplierMayCharge: true });
  });
});

describe('callFirecrawl', () => {
  it('pins the request to one markdown page and refuses PDFs and private hosts before sending', () => {
    expect(buildFirecrawlRequest('https://example.com/a#frag')).toEqual({ url: 'https://example.com/a', request: {
      method: 'POST', url: 'https://api.firecrawl.dev/v1/scrape',
      body: { url: 'https://example.com/a', formats: ['markdown'], onlyMainContent: true } } });
    expect(buildFirecrawlRequest('https://example.com/report.PDF')).toEqual({ reason: 'PDF_NOT_SUPPORTED' });
    for (const bad of ['ftp://example.com', 'https://user:pw@example.com', 'http://localhost:3000', 'http://10.0.0.1/',
      'http://192.168.1.1', 'http://[::1]/', 'http://intranet/', 'not a url']) {
      expect(buildFirecrawlRequest(bad)).toEqual({ reason: 'INVALID_URL' });
    }
  });

  it('returns the clipped page and its credits', async () => {
    const markdown = 'x'.repeat(MAX_MARKDOWN_CHARS + 5);
    const body = { success: true, data: { markdown, metadata: { title: 'T', sourceURL: 'https://example.com/a', statusCode: 200, creditsUsed: 1 } } };
    const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body)));
    expect(result).toMatchObject({ outcome: 'partial', truncated: true, usage: { unit: 'credit', units: '1' } });
    expect(String(result.items[0].fields.markdown)).toHaveLength(MAX_MARKDOWN_CHARS);
    expect(result.items[0].missing).toEqual(['publishedAt', 'language']);
  });

  it('reports a target 404 as a billed failure with no page', async () => {
    const body = { success: true, data: { markdown: 'Not found', metadata: { statusCode: 404, creditsUsed: 1 } } };
    expect(await callFirecrawl('https://example.com/gone', deps(jsonFetch(200, body))))
      .toMatchObject({ outcome: 'failed', reason: 'TARGET_HTTP_404', supplierMayCharge: true, items: [], usage: { units: '1' } });
  });

  it('keeps missing credits null on success', async () => {
    const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, { success: true, data: { markdown: 'hi', metadata: {} } })));
    expect(result).toMatchObject({ outcome: 'ok', usage: { units: null } });
  });
});
