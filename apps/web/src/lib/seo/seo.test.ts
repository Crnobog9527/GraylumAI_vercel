import { afterEach, describe, expect, it, vi } from 'vitest';
import sitemap from '@/app/sitemap';
import { buildPageMetadata, publicPageRobots } from './metadata';
import { PUBLIC_PAGES } from './public-pages';
import { absoluteUrl, hreflangMap } from './site';
import { faqPageJsonLd, organizationJsonLd, serializeJsonLd } from './structured-data';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('absoluteUrl', () => {
  it('builds production URLs without trailing slashes', () => {
    expect(absoluteUrl('/')).toBe('https://www.graylum.com/');
    expect(absoluteUrl('/zh-tw/')).toBe('https://www.graylum.com/zh-tw');
    expect(absoluteUrl('/faq')).toBe('https://www.graylum.com/faq');
    expect(() => absoluteUrl('faq')).toThrow();
  });
});

describe('hreflangMap', () => {
  it('omits hreflang for a page that exists in one language only', () => {
    expect(hreflangMap('zh-TW', '/zh-tw/ig-jingying')).toBeUndefined();
  });

  it('lists every existing version and points x-default at the Simplified one', () => {
    expect(hreflangMap('zh-TW', '/zh-tw/about', { 'zh-Hans': '/about' })).toEqual({
      'zh-TW': 'https://www.graylum.com/zh-tw/about',
      'zh-Hans': 'https://www.graylum.com/about',
      'x-default': 'https://www.graylum.com/about',
    });
  });
});

describe('buildPageMetadata', () => {
  it('builds canonical, Open Graph, Twitter card and brand suffix without keywords', () => {
    const metadata = buildPageMetadata({ title: 'IG 經營', description: '描述', path: '/zh-tw/ig-jingying', locale: 'zh-TW' });
    expect(metadata.title).toEqual({ absolute: 'IG 經營 | Graylum' });
    expect(metadata.alternates).toEqual({ canonical: 'https://www.graylum.com/zh-tw/ig-jingying' });
    expect(metadata.openGraph).toMatchObject({
      url: 'https://www.graylum.com/zh-tw/ig-jingying',
      siteName: 'Graylum',
      type: 'website',
      locale: 'zh_TW',
      images: [{ url: 'https://www.graylum.com/og/default.png', width: 1200, height: 630 }],
    });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
    expect(metadata).not.toHaveProperty('keywords');
  });

  it('keeps an absolute title as given', () => {
    expect(buildPageMetadata({ title: 'Graylum – 首页', absoluteTitle: true, description: 'd', path: '/' }).title)
      .toEqual({ absolute: 'Graylum – 首页' });
  });

  it('indexes public pages only when SITE_INDEXING is exactly public', () => {
    for (const value of [undefined, '', 'true', 'Public', ' public']) {
      expect(publicPageRobots(value)).toEqual({ index: false, follow: false });
    }
    expect(publicPageRobots('public')).toEqual({ index: true, follow: true });
    vi.stubEnv('SITE_INDEXING', 'staging');
    expect(buildPageMetadata({ title: 't', description: 'd', path: '/faq' }).robots).toEqual({ index: false, follow: false });
    vi.stubEnv('SITE_INDEXING', 'public');
    expect(buildPageMetadata({ title: 't', description: 'd', path: '/faq' }).robots).toEqual({ index: true, follow: true });
  });
});

describe('sitemap', () => {
  it('lists every public page once with an absolute URL and date, and nothing behind login', () => {
    const entries = sitemap();
    expect(entries.map(entry => entry.url)).toEqual(PUBLIC_PAGES.map(page => absoluteUrl(page.path)));
    expect(new Set(entries.map(entry => entry.url)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.url).not.toMatch(/\/(app|admin|auth|login|register|profile|positioning)(\/|$)/);
    }
  });
});

describe('structured data', () => {
  it('escapes "<" so page content cannot close the script tag', () => {
    const json = serializeJsonLd(faqPageJsonLd([{ question: '</script><b>', answer: 'a' }]));
    expect(json).not.toContain('<');
    expect(JSON.parse(json).mainEntity[0].name).toBe('</script><b>');
  });

  it('adds contactPoint and sameAs only when given', () => {
    expect(organizationJsonLd()).not.toHaveProperty('contactPoint');
    expect(organizationJsonLd()).not.toHaveProperty('sameAs');
    expect(organizationJsonLd({ supportEmail: 'help@graylum.com' }).contactPoint).toMatchObject({ email: 'help@graylum.com' });
  });
});
