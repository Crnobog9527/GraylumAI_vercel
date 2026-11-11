import { describe, expect, it } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config, normalizeHostname } from './proxy';

// Since the single-host move (E1) no host is special: login is decided by path on every host
// (proxy-public-site.test.ts). The host name is only normalized for the session cookie settings.
describe('proxy hostname normalization', () => {
  it.each([
    ['www.graylum.com', 'www.graylum.com'],
    ['WWW.Graylum.COM.', 'www.graylum.com'],
    ['auth-staging.graylum.com:443', 'auth-staging.graylum.com'],
    ['localhost:3000', 'localhost'],
    ['localhost.', 'localhost'],
  ])('%s becomes %s', (hostname, normalized) => {
    expect(normalizeHostname(hostname)).toBe(normalized);
  });
});


describe('public font resources', () => {
  it('bypasses auth only for the public font resource directories', () => {
    for (const url of ['/fonts/misans/abc.woff2', '/fonts/misans/misans-abc.css', '/fonts/misans/LICENSE.pdf',
      '/fonts/noto-sans-cjk-display/LICENSE.txt']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    }
    for (const url of ['/app/positioning', '/app/profile', '/admin', '/fonts/private.woff2', '/fonts/misans-private/secret',
      '/fonts/noto-sans-cjk-display-private/secret']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });
});


describe('public crawler resources', () => {
  it('serves robots directly on every host without bypassing neighboring paths', () => {
    for (const host of ['app.graylum.com', 'www.graylum.com', 'preview.vercel.app', 'localhost']) {
      for (const path of ['/robots.txt', '/robots.txt?crawler=1']) {
        expect(unstable_doesMiddlewareMatch({ config, url: `https://${host}${path}` })).toBe(false);
      }
    }
    for (const url of ['/robotsXtxt', '/robots.txt/private', '/robots.txt-backup', '/profile', '/admin']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });
});

describe('public sitemap', () => {
  it('serves sitemap.xml directly on every host without bypassing neighboring paths', () => {
    for (const host of ['app.graylum.com', 'www.graylum.com', 'auth-staging.graylum.com', 'preview.vercel.app', 'localhost']) {
      for (const path of ['/sitemap.xml', '/sitemap.xml?crawler=1']) {
        expect(unstable_doesMiddlewareMatch({ config, url: `https://${host}${path}` })).toBe(false);
      }
    }
    for (const url of ['/sitemapXxml', '/sitemap.xml/private', '/sitemap.xml.bak', '/sitemap.xmlx', '/zh-tw/sitemap.xml', '/profile']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });
});

describe('image file names (deep review 11-11 item 8)', () => {
  it('serves real image files directly', () => {
    for (const url of ['/graylum-logo.png', '/graylum-logo.svg', '/og/home.png', '/opc-reference/a/b.webp', '/apix.png',
      '/api.png', '/landing/hero.jpg']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    }
  });

  it('keeps every API path in the proxy whatever its suffix', () => {
    const batch = `/api/trpc/${Array.from({ length: 300 }, () => 'settings.getSystemSettings').join(',')},x.png?batch=1`;
    for (const url of [batch, '/api/trpc/x.png', '/api/trpc/a,b,x.svg?batch=1', '/api/trpc/x.jpeg', '/api/trpc/x.gif',
      '/api/trpc/x.webp', '/api/trpc/x.jpg', '/api/upload/x.png', '/api/auth/phone/send/x.png', '/api/x.png']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });
});
