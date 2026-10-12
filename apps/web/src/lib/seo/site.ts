/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// Public-site constants (docs/launch/SEO_GEO_SPEC.md sections 2, 3.1 and 5). Canonical URLs always
// point at the single production host, on every environment; staging stays out of indexes through
// noindex, not through a different canonical.
export const SITE_ORIGIN = 'https://www.graylum.com';
export const SITE_NAME = 'Graylum';
export const LEGAL_NAME = 'Grayscale Luminary LLC';
export const DEFAULT_OG_IMAGE = '/og/default.png';

export type SiteLocale = 'zh-Hans' | 'zh-TW';

type LocaleConfig = {
  // Path prefix for this language; the default language lives at the root.
  prefix: string;
  htmlLang: string;
  hreflang: string;
  ogLocale: string;
};

export const SITE_LOCALES: Record<SiteLocale, LocaleConfig> = {
  'zh-Hans': { prefix: '', htmlLang: 'zh-Hans', hreflang: 'zh-Hans', ogLocale: 'zh_CN' },
  'zh-TW': { prefix: '/zh-tw', htmlLang: 'zh-Hant-TW', hreflang: 'zh-TW', ogLocale: 'zh_TW' },
};

export const DEFAULT_LOCALE: SiteLocale = 'zh-Hans';

/** Absolute URL on the production host; `/` stays `/`, other paths never get a trailing slash. */
export function absoluteUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`SEO paths must start with "/": ${path}`);
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return `${SITE_ORIGIN}${normalized}`;
}

/**
 * hreflang map for a page that exists in more than one language, or undefined for a single-language
 * page (spec 3.1: never point at a translation that does not exist). x-default is the root version.
 */
export function hreflangMap(
  locale: SiteLocale,
  path: string,
  alternates: Partial<Record<SiteLocale, string>> = {},
): Record<string, string> | undefined {
  const versions: Partial<Record<SiteLocale, string>> = { ...alternates, [locale]: path };
  if (Object.keys(versions).length < 2) {
    return undefined;
  }

  const languages: Record<string, string> = {};
  for (const [key, versionPath] of Object.entries(versions) as [SiteLocale, string][]) {
    languages[SITE_LOCALES[key].hreflang] = absoluteUrl(versionPath);
  }
  const fallback = versions[DEFAULT_LOCALE];
  if (fallback) {
    languages['x-default'] = absoluteUrl(fallback);
  }
  return languages;
}
