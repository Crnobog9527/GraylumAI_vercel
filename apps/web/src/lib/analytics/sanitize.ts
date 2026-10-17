/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { routeTemplate } from './routes';
import { registeredUtm } from './utm-registry';

/**
 * Address clean-up shared by GA and Vercel (ANALYTICS plan §3.1, §3.3): the path becomes its route template,
 * the fragment and every query parameter go except registered UTM values, and a referrer from another site
 * keeps only its origin. Returns null when the address must not be reported.
 */
export function sanitizePageUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const template = routeTemplate(url.pathname);
  if (!template) return null;
  const query = new URLSearchParams(registeredUtm(url.search)).toString();
  return `${url.origin}${template}${query ? `?${query}` : ''}`;
}

/** A referrer safe to report: another site → its origin only; this site → its route template (or origin). */
export function sanitizeReferrer(referrer: string, ownOrigin: string): string {
  if (!referrer) return '';
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.origin !== ownOrigin) return url.origin;
  const template = routeTemplate(url.pathname);
  return template ? `${url.origin}${template}` : url.origin;
}

/** Fixed page title: the template, never the document title (it can name a draft or a document). */
export function pageTitleFor(pageUrl: string): string {
  return new URL(pageUrl).pathname;
}
