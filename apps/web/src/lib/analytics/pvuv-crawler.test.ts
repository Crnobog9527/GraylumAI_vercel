import { describe, expect, it, vi } from 'vitest';
import { crawlerHitRequest, isCrawlerPageHit, reportCrawlerHit } from './pvuv-crawler';

const env = { PVUV_SITE: 'site_abc123', PVUV_INGEST_TOKEN: 'token-value-123' };
const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';

describe('crawler detection', () => {
  it.each([
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)',
    'Perplexity-User/1.0', 'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0)', 'Claude-User/1.0',
    'Mozilla/5.0 (compatible; bingbot/2.0)', 'Mozilla/5.0 (compatible; Googlebot/2.1)', GPT,
  ])('recognises %s', ua => {
    expect(isCrawlerPageHit('GET', '/pricing', ua)).toBe(true);
  });

  it('never reports logged-in, sensitive, email-like or token-like paths (decoded before checking)', () => {
    for (const path of ['/app', '/app/positioning/abc', '/admin/users', '/auth/callback', '/reset-password', '/verify-email',
      '/%61pp/positioning', '/blog/me%40example.com', '/blog/me@example.com', '/share/0123456789abcdef0123456789abcdef0123', '/bad%']) {
      expect(isCrawlerPageHit('GET', path, GPT), path).toBe(false);
    }
    expect(crawlerHitRequest({ method: 'GET', pathname: '/app/x', userAgent: GPT, ip: null }, env)).toBeNull();
  });

  it('ignores ordinary browsers, non-page paths and other methods', () => {
    expect(isCrawlerPageHit('GET', '/pricing', 'Mozilla/5.0 (Macintosh) Safari/605.1.15')).toBe(false);
    expect(isCrawlerPageHit('GET', '/pricing', null)).toBe(false);
    expect(isCrawlerPageHit('POST', '/pricing', GPT)).toBe(false);
    expect(isCrawlerPageHit('GET', '/api/trpc/x', GPT)).toBe(false);
    expect(isCrawlerPageHit('GET', '/_next/data/x.json', GPT)).toBe(false);
    expect(isCrawlerPageHit('GET', '/logo.png', GPT)).toBe(false);
    expect(isCrawlerPageHit('GET', '/llms.txt', GPT)).toBe(true);
    expect(isCrawlerPageHit('HEAD', '/blog/post', GPT)).toBe(true);
  });
});

describe('crawler hit report', () => {
  it('builds the pvuv request with the path only (no query) and the client address', () => {
    const prepared = crawlerHitRequest({ method: 'GET', pathname: '/blog/post', userAgent: GPT, ip: '20.171.1.2' }, env, 1_700_000_000_000)!;
    expect(prepared.url).toBe('https://api.pvuv.ai/v1/sites/site_abc123/crawler_hits');
    expect((prepared.init.headers as Record<string, string>).authorization).toBe('Bearer token-value-123');
    expect(JSON.parse(prepared.init.body as string)).toEqual({ hits: [{ ua: GPT, path: '/blog/post', ip: '20.171.1.2', ts: 1_700_000_000_000 }] });
  });

  it('is off without the site and the token', () => {
    expect(crawlerHitRequest({ method: 'GET', pathname: '/', userAgent: GPT, ip: null }, {})).toBeNull();
    expect(crawlerHitRequest({ method: 'GET', pathname: '/', userAgent: GPT, ip: null }, { PVUV_SITE: 'site_abc123' })).toBeNull();
  });

  it('is handed to waitUntil and never awaited; a failing request is swallowed', async () => {
    const waitUntil = vi.fn();
    const fetch = vi.fn().mockRejectedValue(new Error('down'));
    const request = { method: 'GET', nextUrl: { pathname: '/pricing' }, headers: new Headers({ 'user-agent': GPT, 'x-real-ip': '20.171.1.2' }) };
    expect(reportCrawlerHit(request, { waitUntil }, { env, fetch })).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it('reports nothing for a person, or when the host gives no waitUntil', () => {
    const waitUntil = vi.fn();
    const person = { method: 'GET', nextUrl: { pathname: '/pricing' }, headers: new Headers({ 'user-agent': 'Mozilla/5.0 Safari' }) };
    expect(reportCrawlerHit(person, { waitUntil }, { env })).toBe(false);
    const bot = { method: 'GET', nextUrl: { pathname: '/pricing' }, headers: new Headers({ 'user-agent': GPT }) };
    expect(reportCrawlerHit(bot, undefined, { env })).toBe(false);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
