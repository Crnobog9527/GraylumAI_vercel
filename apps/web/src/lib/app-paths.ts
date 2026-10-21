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

// Moved folders with no page of their own: only their subpages moved (/workbench/marketplace, /workbench/search).
// The folder address itself is not redirected and answers 404, like the retired /chat (Owner 2026-10-21: the
// site has no real users yet, so the old /chat and /workbench entries are not kept).
export const SEGMENTS_WITHOUT_INDEX: readonly string[] = ['workbench'];

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
  const parts = path.split('/').filter(Boolean);
  const segment = parts[0];
  if (!(MOVED_APP_SEGMENTS as readonly string[]).includes(segment)) return target;
  // A folder without a page stays as it is (404), instead of becoming a missing /app address.
  return parts.length === 1 && SEGMENTS_WITHOUT_INDEX.includes(segment) ? target : `${APP_PREFIX}${target}`;
}
