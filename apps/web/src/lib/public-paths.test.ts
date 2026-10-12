import { describe, expect, it } from 'vitest';
import { isPublicPathname } from './public-paths';

describe('isPublicPathname', () => {
  it('opens listed paths and the pages below them', () => {
    for (const path of ['/login', '/forgot-password', '/reset-password', '/reset-password/', '/auth/callback', '/api/trpc/x',
      '/about', '/zh-tw', '/zh-tw/', '/zh-tw/ig-jingying', '/zh-tw/about']) {
      expect(isPublicPathname(path)).toBe(true);
    }
  });

  it('matches whole path segments only', () => {
    for (const path of ['/reset-password-admin', '/loginx', '/authority', '/apix', '/profile', '/',
      '/zh-twx', '/zh-tw-admin', '/aboutx', '/about-us', '/positioning', '/admin']) {
      expect(isPublicPathname(path)).toBe(false);
    }
  });
});
