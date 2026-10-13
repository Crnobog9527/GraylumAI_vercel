/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Metadata } from 'next';
import { buildPageMetadata } from './metadata';
import type { SiteLocale } from './site';

// Content of a public keyword or info page, rendered by components/public-site/ArticlePage
// (SEO_GEO_SPEC sections 6, 7, 8 and 10). Product claims may only describe launched or in-scope features.
export type ArticleBlock = {
  paragraphs: string[];
  list?: string[];
};

export type ArticleSection = ArticleBlock & {
  h2: string;
  subsections?: (ArticleBlock & { h3: string })[];
};

export type ArticleContent = {
  locale: SiteLocale;
  path: string;
  alternates?: Partial<Record<SiteLocale, string>>;
  metaTitle: string;
  metaDescription: string;
  // From the home of this language down to this page.
  breadcrumb: { name: string; path: string }[];
  h1: string;
  // First-screen answer, under 100 characters (spec 7.1).
  lead: string;
  // Checkable points right under the answer (spec 12.3).
  keyPoints?: string[];
  // A 2–3 sentence passage AI search can quote as is (spec 7.4).
  definition?: { term: string; text: string };
  cta: { label: string; description: string; href: string };
  sections: ArticleSection[];
  // Only questions answered visibly on the page; they also feed FAQPage JSON-LD.
  faq?: { question: string; answer: string }[];
  related: { label: string; href: string; description: string }[];
  // Official or public sources behind platform facts on the page (spec 12.4); shown as a visible list.
  sources?: { label: string; href: string }[];
  updated: string;
};

export function articleMetadata(content: ArticleContent): Metadata {
  return buildPageMetadata({
    title: content.metaTitle,
    description: content.metaDescription,
    path: content.path,
    locale: content.locale,
    alternates: content.alternates,
  });
}
