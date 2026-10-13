/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Parallel and Firecrawl adapters against fetch doubles; response shapes follow RESEARCH-0 (#466, #465).
import { describe, expect, it } from 'vitest';
import { buildParallelRequest, callParallel, parallelModeFor, parallelUsage } from '../parallel';
import { buildFirecrawlRequest, callFirecrawl, firecrawlCredits, MAX_MARKDOWN_BYTES } from '../firecrawl';
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

  it('keeps huge digit strings out of counts instead of returning Infinity', async () => {
    const { count } = await import('../fields');
    expect(count({ n: '9'.repeat(400) }, ['n'])).toBeUndefined();
    expect(count({ n: '12' }, ['n'])).toBe(12);
    const { displayCount } = await import('../fields');
    expect(displayCount({ v: '343,369 views' }, ['v'])).toBe(343369);
    for (const bad of [', views', '1,,2 views', '12,34 views', `${'9'.repeat(400)} views`, '1.2M views']) {
      expect(displayCount({ v: bad }, ['v'])).toBeUndefined();
    }
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
      objective: 'Find recent, reliable web pages about: 露营装备 推荐', search_queries: ['露营装备 推荐'], mode: 'fast',
    });
    expect(result.route).toBe('parallel:search:fast');
    await callParallel('q', deps(jsonFetch(200, body, calls)), parallelModeFor('pro'));
    expect(JSON.parse(String(calls[1].init.body)).mode).toBe('advanced');
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

  it('separates a real empty result set from malformed entries', async () => {
    expect(await callParallel('q', deps(jsonFetch(200, { results: [], usage: [{ name: 'sku_search', count: 1 }] }))))
      .toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS', items: [], usage: { units: '1' } });
    expect(await callParallel('q', deps(jsonFetch(200, { results: [{}, { title: 'no url' }], usage: [{ name: 'sku_search', count: 1 }] }))))
      .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', items: [] });
    expect(await callParallel('q', deps(jsonFetch(200, { results: [{ url: '   ' }, { url: 'not a URL' }, { url: 'javascript:alert(1)' }] }))))
      .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
    const mixed = await callParallel('q', deps(jsonFetch(200, { results: [{}, { url: ' https://a.example ', title: 'A' }] })));
    expect(mixed.items.map(item => item.url)).toEqual(['https://a.example/']);
  });

  it('treats an empty 200 body as unknown for every supplier', async () => {
    expect(await callParallel('q', deps(jsonFetch(200, '')))).toMatchObject({ outcome: 'unknown', reason: 'RESPONSE_EMPTY' });
    expect(await callFirecrawl('https://example.com/a', deps(jsonFetch(200, ''))))
      .toMatchObject({ outcome: 'unknown', reason: 'RESPONSE_EMPTY' });
    expect(await callParallel('q', deps(jsonFetch(503, '')))).toMatchObject({ outcome: 'failed', reason: 'RESPONSE_EMPTY' });
  });

  it('refuses empty, overlong or unsupported-mode queries without sending', async () => {
    expect(buildParallelRequest(' ')).toEqual({ reason: 'INVALID_QUERY' });
    expect(buildParallelRequest('a'.repeat(201))).toEqual({ reason: 'INVALID_QUERY' });
    expect(buildParallelRequest('q', 'turbo' as never)).toEqual({ reason: 'MODE_NOT_SUPPORTED' });
  });

  it('classifies HTTP errors and timeouts', async () => {
    expect(await callParallel('q', deps(jsonFetch(401, { error: 'bad key' }))))
      .toMatchObject({ outcome: 'failed', reason: 'HTTP_401', supplierMayCharge: false });
    expect(await callParallel('q', deps(hangingFetch()))).toMatchObject({ outcome: 'unknown', reason: 'TIMEOUT', usage: { units: null } });
    expect(await callParallel('q', deps(jsonFetch(200, 'not json'))))
      .toMatchObject({ outcome: 'unknown', reason: 'RESPONSE_NOT_JSON', supplierMayCharge: true });
    expect(await callParallel('q', deps(jsonFetch(500, 'oops'))))
      .toMatchObject({ outcome: 'failed', reason: 'RESPONSE_NOT_JSON', supplierMayCharge: false });
  });
});

describe('callFirecrawl', () => {
  it('pins the request to one markdown page and refuses PDFs and private hosts before sending', () => {
    expect(buildFirecrawlRequest('https://example.com/a#frag')).toEqual({ url: 'https://example.com/a', request: {
      method: 'POST', url: 'https://api.firecrawl.dev/v1/scrape',
      body: { url: 'https://example.com/a', formats: ['markdown'], onlyMainContent: true, parsePDF: false, proxy: 'basic' } } });
    expect(buildFirecrawlRequest('https://example.com/report.PDF')).toEqual({ reason: 'PDF_NOT_SUPPORTED' });
    for (const bad of ['ftp://example.com', 'https://user:pw@example.com', 'http://localhost:3000', 'http://10.0.0.1/',
      'http://192.168.1.1', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[::]/', 'http://[2001:db8::1]/',
      'http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://192.0.0.8/', 'http://localhost./', 'http://foo.local./', 'http://bar.internal../', 'http://100.64.0.1/', 'http://198.18.0.1/', 'http://0.0.0.0/', 'http://2130706433/', 'http://intranet/', 'not a url']) {
      expect(buildFirecrawlRequest(bad)).toEqual({ reason: 'INVALID_URL' });
    }
  });

  it('returns the clipped page and its credits', async () => {
    const markdown = 'x'.repeat(MAX_MARKDOWN_BYTES + 5);
    const body = { success: true, data: { markdown, metadata: { title: 'T', sourceURL: 'https://example.com/a', statusCode: 200, creditsUsed: 1 } } };
    const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body)));
    expect(result).toMatchObject({ outcome: 'partial', truncated: true, usage: { unit: 'credit', units: '1' } });
    expect(Buffer.byteLength(String(result.items[0].fields.markdown))).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    const cjk = { success: true, data: { markdown: `${'中'.repeat(5000)}\n\n${'文'.repeat(5000)}`, metadata: { creditsUsed: 1 } } };
    const page = await callFirecrawl('https://example.com/zh', deps(jsonFetch(200, cjk)));
    expect(page).toMatchObject({ outcome: 'partial', truncated: true });
    expect(Buffer.byteLength(String(page.items[0].fields.markdown))).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    expect(String(page.items[0].fields.markdown)).toBe('中'.repeat(5000));
    expect(result.items[0].missing).toEqual(['publishedAt', 'language']);
  });

  it('reports a target 404 as a billed failure with no page', async () => {
    const body = { success: true, data: { markdown: 'Not found', metadata: { statusCode: 404, creditsUsed: 1 } } };
    expect(await callFirecrawl('https://example.com/gone', deps(jsonFetch(200, body))))
      .toMatchObject({ outcome: 'failed', reason: 'TARGET_HTTP_404', supplierMayCharge: true, items: [], usage: { units: '1' } });
  });

  it('refuses a PDF that arrives through an extensionless URL or redirect, after the one billed credit', async () => {
    const base64 = { success: true, data: { markdown: 'JVBERi0xLjcKJ...', metadata: { statusCode: 200, creditsUsed: 1 } } };
    expect(await callFirecrawl('https://example.com/download', deps(jsonFetch(200, base64))))
      .toMatchObject({ outcome: 'failed', reason: 'PDF_NOT_SUPPORTED', items: [], usage: { units: '1' } });
    const typed = { success: true, data: { markdown: '', metadata: { contentType: 'application/pdf', creditsUsed: 1 } } };
    expect(await callFirecrawl('https://example.com/d', deps(jsonFetch(200, typed)))).toMatchObject({ reason: 'PDF_NOT_SUPPORTED' });
  });

  it('does not report a success without a recognizable page body', async () => {
    const body = { success: true, data: { metadata: { statusCode: 200, creditsUsed: 1 } } };
    expect(await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body))))
      .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', items: [], supplierMayCharge: true });
    const blank = { success: true, data: { markdown: ' \n\n  ', metadata: { statusCode: 200, creditsUsed: 1 } } };
    expect(await callFirecrawl('https://example.com/a', deps(jsonFetch(200, blank)))).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
  });

  it('keeps missing credits null on success', async () => {
    const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, { success: true, data: { markdown: 'hi', metadata: {} } })));
    expect(result).toMatchObject({ outcome: 'ok', usage: { units: null } });
  });
});
