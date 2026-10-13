/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Parallel and Firecrawl adapters against fetch doubles; response shapes follow RESEARCH-0 (#466, #465).
import { describe, expect, it } from 'vitest';
import { buildParallelRequest, callParallel, parallelModeFor, parallelUsage } from '../parallel';
import { buildFirecrawlRequest, callFirecrawl, firecrawlCredits, MAX_MARKDOWN_BYTES } from '../firecrawl';
import { mayHaveBilled, nonPublicIp, usageUnits } from '../http';
import { FIXED_NOW, hangingFetch, jsonFetch, type RecordedCall } from './fetchDoubles';

// Tests never touch real DNS: targets resolve to a public documentation-free address unless overridden.
const publicDns = async () => ['93.184.215.14'];
const deps = (fetchImpl: typeof fetch, resolveHost: (host: string) => Promise<string[]> = publicDns) =>
  ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50, resolveHost });

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
    for (const bad of [9999.9, '1.5', -1, 2 ** 60]) expect(count({ n: bad }, ['n'])).toBeUndefined();
    expect(count({ views: { count: '123' } }, ['views', 'views.count'])).toBe(123);
    const { displayCount } = await import('../fields');
    expect(displayCount({ v: '343,369 views' }, ['v'])).toBe(343369);
    expect(displayCount({ v: '181 videos' }, ['v'])).toBe(181);
    expect(displayCount({ v: '999 subscribers' }, ['v'])).toBe(999);
    expect(displayCount({ v: '1.2K subscribers' }, ['v'])).toBeUndefined();
    expect(displayCount({ v: '1.2K videos' }, ['v'])).toBeUndefined();
    for (const bad of ['99,999,999,999,999,999,999 views', ', views', '1,,2 views', '12,34 views', `${'9'.repeat(400)} views`, '1.2M views']) {
      expect(displayCount({ v: bad }, ['v'])).toBeUndefined();
    }
  });

  it('keeps implausible timestamps missing instead of inventing recent or future dates', async () => {
    const { timestamp } = await import('../fields');
    expect(timestamp({ t: 1_760_000_000 }, ['t'])).toBe('2025-10-09T08:53:20.000Z');
    expect(timestamp({ t: 1_760_000_000_000 }, ['t'])).toBe('2025-10-09T08:53:20.000Z');
    for (const bad of [1_760_000_000_000_000, 4_102_444_800, '2999-01-01', 1e20]) {
      expect(timestamp({ t: bad }, ['t'])).toBeUndefined();
    }
    // Web pages may be old; social posts cannot predate 2000.
    expect(timestamp({ t: '1998-05-01' }, ['t'])).toBe('1998-05-01T00:00:00.000Z');
    const { SOCIAL_EARLIEST_MS } = await import('../fields');
    expect(timestamp({ t: '1998-05-01' }, ['t'], SOCIAL_EARLIEST_MS)).toBeUndefined();
    expect(timestamp({ t: 12 }, ['t'], SOCIAL_EARLIEST_MS)).toBeUndefined();
  });

  it('reads Firecrawl credits from either documented location', () => {
    expect(firecrawlCredits({ creditsUsed: 1 })).toBe('1');
    // Page-controlled metadata is never a billing receipt.
    expect(firecrawlCredits({ data: { metadata: { creditsUsed: 0 } } })).toBeNull();
    expect(firecrawlCredits({ data: {} })).toBeNull();
  });
});

describe('callParallel', () => {
  it('sends only the keyword query in the tested shape', async () => {
    const calls: RecordedCall[] = [];
    const body = { results: [{ url: 'https://a.example.com/x', title: 'A', excerpts: ['摘要'], publish_date: '2026-09-01' }],
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
    expect(result.items[0]).toEqual({ url: 'https://a.example.com/x',
      fields: { title: 'A', excerpt: '摘要', publishedAt: '2026-09-01T00:00:00.000Z' }, missing: [] });
  });

  it('keeps a missing usage field as null on a successful answer', async () => {
    const result = await callParallel('q', deps(jsonFetch(200, { results: [{ url: 'https://a.example.com', title: 'A' }] })));
    expect(result).toMatchObject({ outcome: 'ok', usage: { units: null } });
    expect(result.items[0].missing).toEqual(['excerpt', 'publishedAt']);
  });

  it('separates a real empty result set from malformed entries', async () => {
    expect(await callParallel('q', deps(jsonFetch(200, { results: [], usage: [{ name: 'sku_search', count: 1 }] }))))
      .toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS', items: [], usage: { units: '1' } });
    expect(await callParallel('q', deps(jsonFetch(200, { results: [{}, { title: 'no url' }], usage: [{ name: 'sku_search', count: 1 }] }))))
      .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', items: [] });
    expect(await callParallel('q', deps(jsonFetch(200, { results: [{ url: '   ' }, { url: 'not a URL' }, { url: 'javascript:alert(1)' },
      { url: 'http://localhost/' }, { url: 'http://127.0.0.1/' }, { url: 'https://foo.test/' }] }))))
      .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
    const mixed = await callParallel('q', deps(jsonFetch(200, { results: [{}, { url: ' https://a.example.com ', title: 'A' }] })));
    expect(mixed.items.map(item => item.url)).toEqual(['https://a.example.com/']);
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
    // Parallel does not document 5xx billing, so it is recorded as possibly billed (the user is still not charged).
    expect(await callParallel('q', deps(jsonFetch(500, 'oops'))))
      .toMatchObject({ outcome: 'failed', reason: 'RESPONSE_NOT_JSON', supplierMayCharge: true });
  });
});

describe('outbound safety', () => {
  it('never follows supplier redirects, so API key headers cannot reach another host', async () => {
    const calls: RecordedCall[] = [];
    const result = await callParallel('q', deps(jsonFetch(302, '', calls)));
    expect(calls[0].init.redirect).toBe('manual');
    expect(result).toMatchObject({ outcome: 'failed', supplierMayCharge: false });
  });

  it('classifies resolved addresses: only global unicast is public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '2001:db8::1', '::', '0.0.0.0']) {
      expect(nonPublicIp(ip)).toBe(true);
    }
    for (const ip of ['3fff::1', '3fff:0fff::1', '2001:2::1', '2001::1', '2002::1', '2620:4f:8000::1', '64:ff9b::1', 'fe80::1%eth0', '1::2::3']) {
      expect(nonPublicIp(ip)).toBe(true);
    }
    for (const ip of ['93.184.215.14', '2606:4700::1111', '::ffff:93.184.215.14', '2a00:1450:4001::200e', '3fff:1000::1']) {
      expect(nonPublicIp(ip)).toBe(false);
    }
  });

  it('marks 2xx and undocumented 5xx as possibly billed', () => {
    expect(mayHaveBilled(200, true)).toBe(true);
    expect(mayHaveBilled(204, false)).toBe(true);
    expect(mayHaveBilled(503, true)).toBe(true);
    expect(mayHaveBilled(503, false)).toBe(false);
    expect(mayHaveBilled(429, true)).toBe(false);
  });

  it('refuses a public-looking name that resolves to a private address, before any request', async () => {
    const calls: RecordedCall[] = [];
    const page = { success: true, creditsUsed: 1, data: { markdown: 'x', metadata: {} } };
    const rebound = await callFirecrawl('https://localtest.me/', deps(jsonFetch(200, page, calls), async () => ['127.0.0.1']));
    expect(rebound).toMatchObject({ outcome: 'not_sent', reason: 'NON_PUBLIC_TARGET', supplierMayCharge: false });
    const mixed = await callFirecrawl('https://mixed.example.com/', deps(jsonFetch(200, page, calls), async () => ['93.184.215.14', '10.0.0.5']));
    expect(mixed).toMatchObject({ outcome: 'not_sent', reason: 'NON_PUBLIC_TARGET' });
    const unresolved = await callFirecrawl('https://nx.example.com/', deps(jsonFetch(200, page, calls), async () => { throw new Error('ENOTFOUND'); }));
    expect(unresolved).toMatchObject({ outcome: 'not_sent', reason: 'NON_PUBLIC_TARGET' });
    expect(calls).toHaveLength(0);
    expect(await callFirecrawl('https://v6.example.com/', deps(jsonFetch(200, page, calls), async () => ['2606:4700::1111'])))
      .toMatchObject({ outcome: 'ok' });
  });

  it('treats an unreadable non-200 2xx as unknown and a 5xx as a failure that may still be billed', async () => {
    expect(await callParallel('q', deps(jsonFetch(202, 'not json')))).toMatchObject({ outcome: 'unknown', supplierMayCharge: true });
    expect(await callParallel('q', deps(jsonFetch(502, { error: 'x' })))).toMatchObject({ outcome: 'failed', supplierMayCharge: true });
  });
});

describe('callFirecrawl', () => {
  it('pins the request to one markdown page and refuses PDFs and private hosts before sending', () => {
    expect(buildFirecrawlRequest('https://example.com/a#frag')).toEqual({ url: 'https://example.com/a', request: {
      method: 'POST', url: 'https://api.firecrawl.dev/v1/scrape',
      body: { url: 'https://example.com/a', formats: ['markdown'], onlyMainContent: true, parsePDF: false, proxy: 'basic' } } });
    expect(buildFirecrawlRequest('https://example.com/report.PDF')).toEqual({ reason: 'PDF_NOT_SUPPORTED' });
    expect(buildFirecrawlRequest('https://example.com/report%2Epdf')).toEqual({ reason: 'PDF_NOT_SUPPORTED' });
    expect(buildFirecrawlRequest('https://example.com/a%2epDf')).toEqual({ reason: 'PDF_NOT_SUPPORTED' });
    expect(buildFirecrawlRequest('https://example.com/bad%E0%A4%A')).toEqual({ reason: 'INVALID_URL' });
    for (const bad of ['ftp://example.com', 'https://user:pw@example.com', 'http://localhost:3000', 'http://10.0.0.1/',
      'http://192.168.1.1', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[::]/', 'http://[2001:db8::1]/',
      'http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://192.0.0.8/', 'http://localhost./',
      'http://printer.home.arpa/', 'https://service.alt/', 'http://foo.test/', 'http://foo.invalid/', 'https://www.example/', 'http://foo.local./', 'http://bar.internal../', 'http://100.64.0.1/', 'http://198.18.0.1/', 'http://0.0.0.0/', 'http://2130706433/', 'http://intranet/', 'not a url']) {
      expect(buildFirecrawlRequest(bad)).toEqual({ reason: 'INVALID_URL' });
    }
  });

  it('returns the clipped page and its credits', async () => {
    const markdown = 'x'.repeat(MAX_MARKDOWN_BYTES + 5);
    const body = { success: true, data: { markdown, metadata: { title: 'T', sourceURL: 'https://example.com/a', statusCode: 200 } }, creditsUsed: 1 };
    const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body)));
    expect(result).toMatchObject({ outcome: 'partial', truncated: true, usage: { unit: 'credit', units: '1' } });
    expect(Buffer.byteLength(String(result.items[0].fields.markdown))).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    const cjk = { success: true, creditsUsed: 1, data: { markdown: `${'中'.repeat(5000)}\n\n${'文'.repeat(5000)}`, metadata: {} } };
    const page = await callFirecrawl('https://example.com/zh', deps(jsonFetch(200, cjk)));
    expect(page).toMatchObject({ outcome: 'partial', truncated: true });
    expect(Buffer.byteLength(String(page.items[0].fields.markdown))).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    expect(String(page.items[0].fields.markdown)).toBe('中'.repeat(5000));
    expect(result.items[0].missing).toEqual(['publishedAt', 'language']);
  });

  it('never reports a non-public or non-http page URL from the supplier', async () => {
    for (const sourceURL of ['file:///etc/passwd', 'http://localhost/x', 'https://u:p@example.com/x']) {
      const body = { success: true, creditsUsed: 1, data: { markdown: 'page', metadata: { sourceURL } } };
      const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body)));
      expect(result.items[0].url).toBe('https://example.com/a');
    }
  });

  it('reports a target 404 as a billed failure with no page', async () => {
    const body = { success: true, creditsUsed: 1, data: { markdown: 'Not found', metadata: { statusCode: 404 } } };
    expect(await callFirecrawl('https://example.com/gone', deps(jsonFetch(200, body))))
      .toMatchObject({ outcome: 'failed', reason: 'TARGET_HTTP_404', supplierMayCharge: true, items: [], usage: { units: '1' } });
  });

  it('refuses a PDF that arrives through an extensionless URL or redirect, after the one billed credit', async () => {
    const base64 = { success: true, creditsUsed: 1, data: { markdown: 'JVBERi0xLjcKJ...', metadata: { statusCode: 200 } } };
    expect(await callFirecrawl('https://example.com/download', deps(jsonFetch(200, base64))))
      .toMatchObject({ outcome: 'failed', reason: 'PDF_NOT_SUPPORTED', items: [], usage: { units: '1' } });
    const raw = { success: true, creditsUsed: 1, data: { markdown: '%PDF-1.7\n%\u00e2\u00e3', metadata: { statusCode: 200 } } };
    expect(await callFirecrawl('https://example.com/raw', deps(jsonFetch(200, raw)))).toMatchObject({ reason: 'PDF_NOT_SUPPORTED' });
    const typed = { success: true, creditsUsed: 1, data: { markdown: '', metadata: { contentType: 'application/pdf' } } };
    expect(await callFirecrawl('https://example.com/d', deps(jsonFetch(200, typed)))).toMatchObject({ reason: 'PDF_NOT_SUPPORTED' });
  });

  it('never turns non-string page content into a page', async () => {
    for (const markdown of [false, true, 12345]) {
      const body = { success: true, creditsUsed: 1, data: { markdown, metadata: {} } };
      expect(await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body)))).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
    }
  });

  it('does not report a success without a recognizable page body', async () => {
    const body = { success: true, creditsUsed: 1, data: { metadata: { statusCode: 200 } } };
    expect(await callFirecrawl('https://example.com/a', deps(jsonFetch(200, body))))
      .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', items: [], supplierMayCharge: true });
    const blank = { success: true, creditsUsed: 1, data: { markdown: ' \n\n  ', metadata: { statusCode: 200 } } };
    expect(await callFirecrawl('https://example.com/a', deps(jsonFetch(200, blank)))).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
  });

  it('keeps missing credits null on success', async () => {
    const result = await callFirecrawl('https://example.com/a', deps(jsonFetch(200, { success: true, data: { markdown: 'hi', metadata: {} } })));
    expect(result).toMatchObject({ outcome: 'ok', usage: { units: null } });
  });
});
