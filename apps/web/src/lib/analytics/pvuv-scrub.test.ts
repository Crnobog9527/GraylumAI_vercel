import { describe, expect, it } from 'vitest';
import { isPvuvHost, isPvuvPath, scrubFirstTouchCookie, scrubPvuvBody, scrubPvuvReferrer, scrubPvuvUrl } from './pvuv-scrub';

const ORIGIN = 'https://www.graylum.com';

describe('pvuv address scrubbing', () => {
  it('keeps origin, path and utm values; drops other parameters and the fragment', () => {
    expect(scrubPvuvUrl(`${ORIGIN}/blog/some-post?utm_source=x&utm_medium=cpc&ref=abc&email=a%40b.co&token=zzz#section`))
      .toBe(`${ORIGIN}/blog/some-post?utm_source=x&utm_medium=cpc`);
    expect(scrubPvuvUrl(`${ORIGIN}/pricing?invite=SECRET#x`)).toBe(`${ORIGIN}/pricing`);
  });

  it('drops a utm value that looks like an email', () => {
    expect(scrubPvuvUrl(`${ORIGIN}/pricing?utm_source=me@example.com`)).toBe(`${ORIGIN}/pricing`);
  });

  it('refuses pages that must never be reported', () => {
    for (const path of ['/app', '/app/positioning/abc', '/admin/users', '/auth/callback', '/reset-password', '/verify-email',
      '/checkout/x', '/account/billing', '/blog/me@example.com',
      '/share/0123456789abcdef0123456789abcdef0123']) {
      expect(scrubPvuvUrl(`${ORIGIN}${path}`), path).toBeNull();
    }
    expect(scrubPvuvUrl('javascript:alert(1)')).toBeNull();
    expect(scrubPvuvUrl('not a url')).toBeNull();
  });

  it('allows public pages', () => {
    for (const path of ['/', '/pricing', '/blog/how-to-position', '/login', '/register', '/zh-tw/ig-jingying']) {
      expect(isPvuvPath(path), path).toBe(true);
    }
  });
});

describe('pvuv referrer and request bodies', () => {
  it('reduces another site to its origin and our own pages to the clean address', () => {
    expect(scrubPvuvReferrer('https://chatgpt.com/c/private-thread?x=1', ORIGIN)).toBe('https://chatgpt.com');
    expect(scrubPvuvReferrer(`${ORIGIN}/pricing?a=1`, ORIGIN)).toBe(`${ORIGIN}/pricing`);
    expect(scrubPvuvReferrer(`${ORIGIN}/auth/callback?code=abc`, ORIGIN)).toBe(ORIGIN);
    expect(scrubPvuvReferrer('', ORIGIN)).toBeUndefined();
  });

  it('cleans u, r and the first touch of one event', () => {
    const body = JSON.stringify({
      s: 'site', e: 'pageview', u: `${ORIGIN}/pricing?utm_source=ig&fbclid=1#h`, r: 'https://www.google.com/search?q=secret',
      vid: 'v1', ft: { s: 'ig', r: 'https://news.example.com/a/b?c=d' },
    });
    expect(JSON.parse(scrubPvuvBody(body, ORIGIN)!)).toEqual({
      s: 'site', e: 'pageview', u: `${ORIGIN}/pricing?utm_source=ig`, r: 'https://www.google.com', vid: 'v1',
      ft: { s: 'ig', r: 'https://news.example.com' },
    });
  });

  it('drops events for private pages from a batch, and the whole request when none is left', () => {
    const ok = { e: 'pageview', u: `${ORIGIN}/pricing` };
    const bad = { e: 'pageview', u: `${ORIGIN}/app/positioning/abc` };
    expect(JSON.parse(scrubPvuvBody(JSON.stringify([ok, bad]), ORIGIN)!)).toEqual([ok]);
    expect(scrubPvuvBody(JSON.stringify([bad]), ORIGIN)).toBeNull();
    expect(scrubPvuvBody(JSON.stringify(bad), ORIGIN)).toBeNull();
    expect(scrubPvuvBody('not json', ORIGIN)).toBeNull();
  });

  it('keeps a verdict request (no address) but cleans its referrer', () => {
    expect(JSON.parse(scrubPvuvBody(JSON.stringify({ s: 'site', vid: 'v', r: 'https://x.com/a?b=1' }), ORIGIN)!))
      .toEqual({ s: 'site', vid: 'v', r: 'https://x.com' });
  });

  it('drops custom properties that contain an email', () => {
    const out = JSON.parse(scrubPvuvBody(JSON.stringify({ e: 'x', u: `${ORIGIN}/`, p: { who: 'a@b.co' } }), ORIGIN)!);
    expect(out.p).toBeUndefined();
  });

  it('rewrites the stored first-touch cookie value', () => {
    const raw = JSON.stringify({ s: 'ig', r: 'https://t.co/abc?x=1' });
    expect(JSON.parse(scrubFirstTouchCookie(raw, ORIGIN)!)).toEqual({ s: 'ig', r: 'https://t.co' });
    expect(scrubFirstTouchCookie('garbage', ORIGIN)).toBeNull();
  });

  it('recognises pvuv.ai hosts only', () => {
    expect(isPvuvHost('in.pvuv.ai')).toBe(true);
    expect(isPvuvHost('www.pvuv.ai')).toBe(true);
    expect(isPvuvHost('evilpvuv.ai')).toBe(false);
    expect(isPvuvHost('pvuv.ai.evil.com')).toBe(false);
  });
});
