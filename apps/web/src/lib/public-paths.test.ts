import { describe, expect, it } from 'vitest';
import { isPublicPathname } from './public-paths';
import { PUBLIC_PAGES } from './seo/public-pages';

describe('isPublicPathname', () => {
  it('opens listed paths and the pages below them', () => {
    for (const path of ['/login', '/forgot-password', '/reset-password', '/reset-password/', '/auth/callback', '/api/trpc/x',
      '/about', '/zh-tw', '/zh-tw/', '/zh-tw/ig-jingying', '/zh-tw/about', '/refund', '/refund/', '/accessibility']) {
      expect(isPublicPathname(path)).toBe(true);
    }
  });

  it('matches whole path segments only', () => {
    for (const path of ['/reset-password-admin', '/loginx', '/authority', '/apix', '/profile', '/',
      '/zh-twx', '/zh-tw-admin', '/aboutx', '/about-us', '/positioning', '/admin',
      '/refunds', '/refund-policy', '/admin/refunds']) {
      expect(isPublicPathname(path)).toBe(false);
    }
  });
});

describe('isPublicPathname: product feature pages', () => {
  it('opens /features and the pages below it, by whole segment only', () => {
    for (const path of ['/features', '/features/', '/features/positioning', '/features/jury']) {
      expect(isPublicPathname(path)).toBe(true);
    }
    for (const path of ['/featuresx', '/features-admin', '/feature', '/admin/features']) {
      expect(isPublicPathname(path)).toBe(false);
    }
  });
});

describe('isPublicPathname: tutorial blog', () => {
  it('opens /blog and the articles below it, by whole segment only', () => {
    for (const path of ['/blog', '/blog/', '/blog/first-positioning-conversation']) {
      expect(isPublicPathname(path)).toBe(true);
    }
    for (const path of ['/blogs', '/blog-admin', '/admin/blog']) {
      expect(isPublicPathname(path)).toBe(false);
    }
  });
});

describe('isPublicPathname: every indexable page in the sitemap list', () => {
  it('lets a logged-out visitor open each of them', () => {
    // '/' is served by the public host rewrite, not by this list.
    const closed = PUBLIC_PAGES.map(page => page.path).filter(path => path !== '/' && !isPublicPathname(path));
    expect(closed).toEqual([]);
  });
  it('opens the comparison page in both languages', () => {
    expect(isPublicPathname('/graylum-vs-chatgpt')).toBe(true);
    expect(isPublicPathname('/zh-tw/graylum-vs-chatgpt')).toBe(true);
    expect(isPublicPathname('/graylum-vs-chatgptx')).toBe(false);
  });
});
