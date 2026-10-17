/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { absoluteUrl, DEFAULT_LOCALE, LEGAL_NAME, ONE_LINE_DEFINITION, SITE_LOCALES, SITE_NAME, SITE_ORIGIN, type SiteLocale } from './site';

// JSON-LD builders (docs/launch/SEO_GEO_SPEC.md section 10). Everything here must match what the
// page visibly shows: no HowTo, no self-written Review or AggregateRating.

type JsonLdObject = Record<string, unknown>;

const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

export function organizationJsonLd(options: { supportEmail?: string | null; sameAs?: string[] } = {}): JsonLdObject {
  const data: JsonLdObject = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: SITE_NAME,
    legalName: LEGAL_NAME,
    description: ONE_LINE_DEFINITION[DEFAULT_LOCALE],
    url: absoluteUrl('/'),
    logo: absoluteUrl('/graylum-logo.png'),
  };
  if (options.supportEmail) {
    data.contactPoint = { '@type': 'ContactPoint', contactType: 'customer support', email: options.supportEmail };
  }
  if (options.sameAs?.length) {
    data.sameAs = options.sameAs;
  }
  return data;
}

export function websiteJsonLd(): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: SITE_NAME,
    url: absoluteUrl('/'),
    inLanguage: [SITE_LOCALES['zh-Hans'].htmlLang, SITE_LOCALES['zh-TW'].htmlLang],
    publisher: { '@id': ORGANIZATION_ID },
  };
}

export function softwareApplicationJsonLd(options: {
  description: string;
  path?: string;
  // Prices exactly as the page's price cards show them; without it the entry says "free to start".
  offers?: { name: string; price: number }[];
}): JsonLdObject {
  const offers = options.offers?.length
    ? options.offers.map(offer => ({ '@type': 'Offer', name: offer.name, price: String(offer.price), priceCurrency: 'USD' }))
    : { '@type': 'Offer', price: '0', priceCurrency: 'USD' };
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: absoluteUrl(options.path ?? '/'),
    description: options.description,
    offers,
    publisher: { '@id': ORGANIZATION_ID },
  };
}

export function webPageJsonLd(options: {
  path: string;
  title: string;
  description: string;
  locale: SiteLocale;
  dateModified?: string;
}): JsonLdObject {
  const data: JsonLdObject = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${absoluteUrl(options.path)}#webpage`,
    url: absoluteUrl(options.path),
    name: options.title,
    description: options.description,
    inLanguage: SITE_LOCALES[options.locale].htmlLang,
    isPartOf: { '@id': WEBSITE_ID },
    publisher: { '@id': ORGANIZATION_ID },
  };
  if (options.dateModified) {
    data.dateModified = options.dateModified;
  }
  return data;
}

/** A blog article (SEO_GEO_SPEC section 10): author and dates as the page shows them. */
export function blogPostingJsonLd(options: {
  path: string;
  title: string;
  description: string;
  locale: SiteLocale;
  published: string;
  modified: string;
  authorName: string;
  authorPath: string;
}): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': `${absoluteUrl(options.path)}#article`,
    mainEntityOfPage: absoluteUrl(options.path),
    headline: options.title,
    description: options.description,
    inLanguage: SITE_LOCALES[options.locale].htmlLang,
    datePublished: options.published,
    dateModified: options.modified,
    author: { '@type': 'Organization', name: options.authorName, url: absoluteUrl(options.authorPath) },
    publisher: { '@id': ORGANIZATION_ID },
    image: absoluteUrl('/og/default.png'),
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

/** Only questions and answers that appear verbatim on the page. */
export function faqPageJsonLd(items: { question: string; answer: string }[]): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

/** Serializes for a <script type="application/ld+json"> body; "<" is escaped so content cannot close the tag. */
export function serializeJsonLd(data: JsonLdObject | JsonLdObject[]): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
