/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from './seo/site';

// Every host refuses crawling unless this server-side switch is exactly "public". Staging also
// deploys with the production target, so VERCEL_ENV cannot tell staging and the public site apart.
export const SITE_INDEXING_ENV = 'SITE_INDEXING';

// Long-term public-site policy (Owner, 2026-10-03; SEO_GEO_SPEC section 11): refuse model-training
// crawlers, allow search and AI answer crawlers.
export const TRAINING_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'Meta-ExternalAgent',
  'Amazonbot',
  'cohere-ai',
  'Diffbot',
  'omgili',
] as const;

export const SEARCH_CRAWLERS = [
  'Googlebot',
  'Bingbot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'DuckAssistBot',
  'Applebot',
] as const;

export const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;

// Only API routes are kept from crawlers. Logged-in and login pages are NOT disallowed: crawlers must be
// able to fetch them to read their noindex (spec 2 and 11). /_next/static and /_next/image stay allowed
// because Google needs them to render public pages.
const CRAWLABLE_DISALLOW = ['/api/'];

export function isPublicIndexingEnabled(value: string | undefined): boolean {
  return value === 'public';
}

export function buildRobots(indexingValue: string | undefined): MetadataRoute.Robots {
  if (!isPublicIndexingEnabled(indexingValue)) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }

  return {
    rules: [
      { userAgent: [...TRAINING_CRAWLERS], disallow: '/' },
      { userAgent: [...SEARCH_CRAWLERS], allow: '/', disallow: CRAWLABLE_DISALLOW },
      { userAgent: '*', allow: '/', disallow: CRAWLABLE_DISALLOW },
    ],
    sitemap: SITEMAP_URL,
  };
}

// Paths that never get indexed, whatever the switch says (spec 2 and 15). Logged-in pages that still live
// at the root until the /app move are listed too, so turning the switch on early cannot expose them.
export const ALWAYS_NOINDEX_PATHS = [
  '/app',
  '/admin',
  '/auth',
  '/login',
  '/register',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/maintenance',
  '/access-denied',
  '/positioning',
  '/runtime',
  '/profile',
  '/library',
  '/marketplace',
  '/workbench',
  '/chat',
] as const;

export const NOINDEX_HEADER = { key: 'X-Robots-Tag', value: 'noindex, nofollow' } as const;

/**
 * next.config header rules for X-Robots-Tag. Off the public environment every response keeps noindex, so
 * staging and previews stay out of results even when linked from elsewhere; robots Disallow alone cannot
 * do that. On the public environment only the always-noindex paths carry it.
 */
export function buildRobotsHeaderRules(indexingValue: string | undefined) {
  if (!isPublicIndexingEnabled(indexingValue)) {
    return [{ source: '/:path*', headers: [NOINDEX_HEADER] }];
  }

  // "/x/:path*" matches "/x" itself and everything below it, but not "/x-other".
  return ALWAYS_NOINDEX_PATHS.map(path => ({ source: `${path}/:path*`, headers: [NOINDEX_HEADER] }));
}
