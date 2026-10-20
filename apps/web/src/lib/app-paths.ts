/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// E1 single host (SEO_GEO_SPEC sections 2 and 15): every logged-in page lives under /app. Login entry pages,
// /auth, /api and /admin stay at the root. Used by the redirects in next.config, by login return targets and
// by the proxy, so an old address always lands on the same page.

export const APP_PREFIX = '/app';

// Top-level folders that moved from the root into /app; each old address keeps its subpath and query.
export const MOVED_APP_SEGMENTS = [
  'positioning',
  'runtime',
  'profile',
  'library',
  'marketplace',
  'workbench',
  'publish-monitor',
  'expert-consult',
] as const;

// Old pages without a page of their own any more (LEGACY-CLOSE): they open positioning, as before the move.
// /workbench itself is listed here; /workbench/marketplace and /workbench/search moved like any other page.
export const RETIRED_APP_PATHS = ['/chat', '/workbench'] as const;
export const RETIRED_APP_DESTINATION = `${APP_PREFIX}/positioning`;

function splitTarget(target: string) {
  const index = target.search(/[?#]/);
  return index >= 0 ? { path: target.slice(0, index), rest: target.slice(index) } : { path: target, rest: '' };
}

/**
 * The /app address for a same-site path that may still use an old root address: a login return target saved
 * before the move, an email link or a bookmark. "/" means the logged-in home, now /app (the root is the public
 * home page). Anything else, including /app paths, login pages and public pages, is returned unchanged.
 */
export function toAppPath(target: string): string {
  const { path, rest } = splitTarget(target);
  if (path === '/') {
    return `${APP_PREFIX}${rest}`;
  }
  // "/workbench/" is the retired page too; /app/workbench itself has no page.
  if ((RETIRED_APP_PATHS as readonly string[]).includes(path.replace(/\/+$/, ''))) {
    return `${RETIRED_APP_DESTINATION}${rest}`;
  }
  const segment = path.split('/')[1];
  return (MOVED_APP_SEGMENTS as readonly string[]).includes(segment) ? `${APP_PREFIX}${target}` : target;
}
