import { describe, expect, it } from 'vitest';
import { isPublicPathname } from './public-paths';

describe('isPublicPathname', () => {
  it('opens listed paths and the pages below them', () => {
    for (const path of ['/login', '/forgot-password', '/reset-password', '/reset-password/', '/auth/callback', '/api/trpc/x']) {
      expect(isPublicPathname(path)).toBe(true);
    }
  });

  it('matches whole path segments only', () => {
    for (const path of ['/reset-password-admin', '/loginx', '/authority', '/apix', '/profile', '/']) {
      expect(isPublicPathname(path)).toBe(false);
    }
  });
});
