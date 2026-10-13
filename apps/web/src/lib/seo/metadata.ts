/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Metadata } from 'next';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { absoluteUrl, DEFAULT_LOCALE, DEFAULT_OG_IMAGE, hreflangMap, SITE_LOCALES, SITE_NAME, type SiteLocale } from './site';

export type PageMetadataInput = {
  // Page title without the brand suffix; " | Graylum" is appended unless `absoluteTitle` is set.
  title: string;
  description: string;
  // Path of this page, e.g. "/zh-tw/ig-jingying". Used for canonical and og:url.
  path: string;
  locale?: SiteLocale;
  // Paths of the same page in other languages. Only list translations that exist (spec 3.1).
  alternates?: Partial<Record<SiteLocale, string>>;
  absoluteTitle?: boolean;
  type?: 'website' | 'article';
  ogImage?: string;
};

export const NOINDEX_ROBOTS: Metadata['robots'] = { index: false, follow: false };

/** Public pages are indexable only on the environment whose SITE_INDEXING switch is exactly "public". */
export function publicPageRobots(indexingValue = process.env[SITE_INDEXING_ENV]): Metadata['robots'] {
  return isPublicIndexingEnabled(indexingValue) ? { index: true, follow: true } : NOINDEX_ROBOTS;
}

/** The only way public pages build metadata (spec section 5): no page assembles its own tags. */
export function buildPageMetadata(input: PageMetadataInput): Metadata {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const title = input.absoluteTitle ? input.title : `${input.title} | ${SITE_NAME}`;
  const url = absoluteUrl(input.path);
  const image = { url: absoluteUrl(input.ogImage ?? DEFAULT_OG_IMAGE), width: 1200, height: 630, alt: SITE_NAME };
  const languages = hreflangMap(locale, input.path, input.alternates);

  return {
    title: { absolute: title },
    description: input.description,
    alternates: languages ? { canonical: url, languages } : { canonical: url },
    openGraph: {
      title,
      description: input.description,
      url,
      siteName: SITE_NAME,
      type: input.type ?? 'website',
      locale: SITE_LOCALES[locale].ogLocale,
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: input.description,
      images: [image.url],
    },
    robots: publicPageRobots(),
  };
}
