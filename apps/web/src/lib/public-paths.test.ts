import { describe, expect, it } from 'vitest';
import { isPublicPathname } from './public-paths';

describe('isPublicPathname', () => {
  it('opens listed paths and the pages below them', () => {
    for (const path of ['/login', '/forgot-password', '/reset-password', '/reset-password/', '/auth/callback', '/api/trpc/x',
      '/about', '/zh-tw', '/zh-tw/', '/zh-tw/ig-jingying', '/zh-tw/about', '/refund', '/refund/']) {
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
