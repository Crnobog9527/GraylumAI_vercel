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
  // Footer link text for content pages of this language; pages without one stay out of the footer list.
  footerLabel?: string;
  // Same page in other languages; only translations that exist.
  alternates?: Partial<Record<SiteLocale, string>>;
};

export const PUBLIC_PAGES: PublicPage[] = [
  // The public host serves the home page at "/" (rewritten to /landing until the single-host move).
  { path: '/', locale: 'zh-Hans', lastModified: '2026-10-18' },
  { path: '/pricing', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/features', locale: 'zh-Hans', lastModified: '2026-10-17', footerLabel: '功能介绍' },
  { path: '/features/positioning', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/features/content', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/features/jury', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/features/library', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/features/publish', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/features/review', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/blog', locale: 'zh-Hans', lastModified: '2026-10-17', footerLabel: '教程' },
  { path: '/blog/first-positioning-conversation', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/blog/before-you-start-posting', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/accessibility', locale: 'zh-Hans', lastModified: '2026-10-19' },
  { path: '/refund', locale: 'zh-Hans', lastModified: '2026-10-17' },
  { path: '/founders', locale: 'zh-Hans', lastModified: '2026-10-19' },
  { path: '/graylum-vs-chatgpt', locale: 'zh-Hans', lastModified: '2026-10-18', alternates: { 'zh-TW': '/zh-tw/graylum-vs-chatgpt' } },
  { path: '/faq', locale: 'zh-Hans', lastModified: '2026-10-18' },
  { path: '/contact', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/terms', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/privacy', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/acceptable-use', locale: 'zh-Hans', lastModified: '2026-10-12' },
  { path: '/about', locale: 'zh-Hans', lastModified: '2026-10-13', alternates: { 'zh-TW': '/zh-tw/about' } },
  // Traditional Chinese (Taiwan), SEO_GEO_SPEC 3.2 and appendix B.
  { path: '/zh-tw', locale: 'zh-TW', lastModified: '2026-10-12', footerLabel: '自媒體是什麼？' },
  { path: '/zh-tw/about', locale: 'zh-TW', lastModified: '2026-10-13', alternates: { 'zh-Hans': '/about' } },
  { path: '/zh-tw/zimeiti-jingying', locale: 'zh-TW', lastModified: '2026-10-12', footerLabel: '如何經營自媒體' },
  { path: '/zh-tw/shequn-xingxiao', locale: 'zh-TW', lastModified: '2026-10-12', footerLabel: '社群行銷' },
  { path: '/zh-tw/shequn-jingying', locale: 'zh-TW', lastModified: '2026-10-12', footerLabel: '社群經營' },
  { path: '/zh-tw/ig-jingying', locale: 'zh-TW', lastModified: '2026-10-12', footerLabel: 'IG 經營' },
  { path: '/zh-tw/graylum-vs-chatgpt', locale: 'zh-TW', lastModified: '2026-10-18', alternates: { 'zh-Hans': '/graylum-vs-chatgpt' } },
  { path: '/zh-tw/zimeiti-kecheng', locale: 'zh-TW', lastModified: '2026-10-12', footerLabel: '自媒體課程' },
];
