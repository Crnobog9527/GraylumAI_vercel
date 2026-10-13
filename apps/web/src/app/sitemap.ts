/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { MetadataRoute } from 'next';
import { PUBLIC_PAGES } from '@/lib/seo/public-pages';
import { absoluteUrl, hreflangMap, type SiteLocale } from '@/lib/seo/site';

const LOCALE_ORDER: SiteLocale[] = ['zh-Hans', 'zh-TW'];

export default function sitemap(): MetadataRoute.Sitemap {
  // Grouped by language (spec 3.1); each entry carries its translations when they exist.
  const pages = [...PUBLIC_PAGES].sort((a, b) => LOCALE_ORDER.indexOf(a.locale) - LOCALE_ORDER.indexOf(b.locale));

  return pages.map(page => {
    const entry: MetadataRoute.Sitemap[number] = {
      url: absoluteUrl(page.path),
      lastModified: page.lastModified,
    };
    const languages = hreflangMap(page.locale, page.path, page.alternates);
    if (languages) {
      entry.alternates = { languages };
    }
    return entry;
  });
}
