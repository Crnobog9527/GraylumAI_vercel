/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { APP_PREFIX, MOVED_APP_SEGMENTS, RETIRED_APP_DESTINATION, RETIRED_APP_PATHS } from './app-paths';

// next.config redirects for the single host (E1, SEO_GEO_SPEC sections 2 and 15). They run before the proxy
// and before any page, so an old address never reaches the login check.

/**
 * Turns on the 308s from app.graylum.com and graylum.com to www. Off unless exactly "true": while Vercel still
 * sends www to app with the temporary 307 (E2), both directions together would loop. Read at build time, so
 * a change needs a new deployment. Staging is not affected either way: its host is neither of the two.
 */
export const SINGLE_HOST_REDIRECTS_ENV = 'SINGLE_HOST_REDIRECTS';
export const PRODUCTION_ORIGIN = 'https://www.graylum.com';
const LEGACY_HOSTS = ['app.graylum.com', 'graylum.com'] as const;
// GoTrue falls back to the Site URL root with these when it does not accept a requested redirect; the root
// handles them (proxy routeAuthLanding), so on the old app host they must keep the root instead of /app.
const AUTH_LANDING_QUERY_KEYS = ['code', 'error'] as const;

type RouteHas = { type: 'host'; value: string } | { type: 'query'; key: string };
export type ConfigRedirect = { source: string; destination: string; permanent: boolean; has?: RouteHas[] };

/** Redirects on every host. Next.js keeps the query string; permanent ones are 308 and keep the request method. */
export function buildPathRedirects(): ConfigRedirect[] {
  return [
    // LEGACY-CLOSE: the old /chat and /workbench pages are deleted; their links land on positioning, reversibly.
    ...RETIRED_APP_PATHS.map(source => ({ source, destination: RETIRED_APP_DESTINATION, permanent: false })),
    // Logged-in pages moved under /app; ":path*" also matches the folder itself.
    ...MOVED_APP_SEGMENTS.map(segment => ({
      source: `/${segment}/:path*`,
      destination: `${APP_PREFIX}/${segment}/:path*`,
      permanent: true,
    })),
    // The public home page is served at "/" (the proxy rewrites it to this page), so its own address goes there.
    { source: '/landing', destination: '/', permanent: true },
    // The old /tutorials page (four generic cards) is gone; the tutorials live in the blog (PUBLIC-SITE cleanup).
    { source: '/tutorials', destination: '/blog', permanent: true },
    // The pricing page moved from /landing/pricing to /pricing (2026-10-18, SEO_GEO_SPEC section 15).
    { source: '/landing/pricing', destination: '/pricing', permanent: true },
  ];
}

function hostCondition(host: string): RouteHas {
  // The value is a regular expression matched against the whole host name.
  return { type: 'host', value: host.replace(/\./g, '\\.') };
}

/**
 * The old hosts 308 to www in one step: logged-in pages get the /app prefix ("app.graylum.com/" is the logged-in
 * home), old addresses go straight to their final page, and everything else (/auth, /api, /admin, login pages,
 * public pages) keeps its path and only changes host; Next.js serves /_next files without redirects. Payment webhooks must not depend on this
 * (D4, N13): their host is moved to www before the switch is turned on.
 */
export function buildLegacyHostRedirects(switchValue: string | undefined): ConfigRedirect[] {
  if (switchValue !== 'true') {
    return [];
  }

  return LEGACY_HOSTS.flatMap(host => {
    const onHost = hostCondition(host);
    const root: ConfigRedirect[] = host === 'app.graylum.com'
      ? [
          ...AUTH_LANDING_QUERY_KEYS.map(key => ({
            source: '/',
            has: [onHost, { type: 'query' as const, key }],
            destination: `${PRODUCTION_ORIGIN}/`,
            permanent: true,
          })),
          { source: '/', has: [onHost], destination: `${PRODUCTION_ORIGIN}${APP_PREFIX}`, permanent: true },
        ]
      : [];

    return [
      ...root,
      ...buildPathRedirects().map(rule => ({
        source: rule.source,
        has: [onHost],
        destination: `${PRODUCTION_ORIGIN}${rule.destination}`,
        permanent: true,
      })),
      { source: '/:path*', has: [onHost], destination: `${PRODUCTION_ORIGIN}/:path*`, permanent: true },
    ];
  });
}
