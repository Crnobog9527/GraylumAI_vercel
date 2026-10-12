/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { SiteLocale } from './site';

// Every indexable public page, the source for sitemap.xml (SEO_GEO_SPEC section 11). Add a page here in
// the same PR that creates it; never list redirects, login pages or anything behind login. Bump
// `lastModified` when the visible content of a page changes.
export type PublicPage = {
  path: string;
  locale: SiteLocale;
  lastModified: string;
  // Same page in other languages; only translations that exist.
  alternates?: Partial<Record<SiteLocale, string>>;
};

export const PUBLIC_PAGES: PublicPage[] = [
  // The public host serves the home page at "/" (rewritten to /landing until the single-host move).
  { path: '/', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/landing/pricing', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/tutorials', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/faq', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/contact', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/terms', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/privacy', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/acceptable-use', locale: 'zh-Hans', lastModified: '2026-10-12' },
];
