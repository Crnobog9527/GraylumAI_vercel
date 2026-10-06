/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { MetadataRoute } from 'next';

// Every host refuses crawling unless this server-side switch is exactly "public". Staging also
// deploys with the production target, so VERCEL_ENV cannot tell staging and the public site apart.
export const SITE_INDEXING_ENV = 'SITE_INDEXING';

// Long-term public-site policy (Owner, 2026-10-03): refuse model-training crawlers, allow search
// and AI answer crawlers.
export const TRAINING_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'Meta-ExternalAgent',
] as const;

export const SEARCH_CRAWLERS = [
  'Googlebot',
  'Bingbot',
  'OAI-SearchBot',
  'Claude-SearchBot',
  'PerplexityBot',
] as const;

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
      { userAgent: [...SEARCH_CRAWLERS], allow: '/' },
      { userAgent: '*', allow: '/' },
    ],
  };
}
