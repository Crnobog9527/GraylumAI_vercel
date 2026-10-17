/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { analyticsAllowed, readTermlyConsent } from './consent';
import { pageTitleFor, sanitizePageUrl, sanitizeReferrer } from './sanitize';

/**
 * GA4 in the browser (ANALYTICS plan §3.1, O2). gtag.js is a Termly-classified tag (category analytics) that
 * Termly releases after consent; this code fills its command queue only with live consent and on a page we may
 * report. Page views are sent by this code alone (`send_page_view: false`), with the
 * cleaned address, referrer and a fixed title set globally first, so GA's own automatic events
 * (session_start, first_visit, user_engagement) carry the same cleaned values. On a sensitive page, or when
 * consent is withdrawn, Google's opt-out switch `ga-disable-<ID>` stops every request; it flips back when
 * consent returns. Google signals and ad personalisation signals stay off; no user ID is ever set.
 */
type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
    [gaDisable: `ga-disable-${string}`]: boolean | undefined;
  }
}

type Page = { location: string | null; referrer: string; navigation: number };

let loadedFor: string | null = null;
let page: Page | null = null;
let navigation = 0;
let pageViewSentFor = -1;

const consentFields = (advertising: boolean) => {
  const ads = advertising ? 'granted' : 'denied';
  return { analytics_storage: 'granted', ad_storage: ads, ad_user_data: ads, ad_personalization: ads };
};

function load(measurementId: string) {
  window.dataLayer = window.dataLayer || [];
  // gtag must push the `arguments` object itself, exactly as Google's snippet does.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  });
  window.gtag('consent', 'update', consentFields(readTermlyConsent().advertising));
  window.gtag('js', new Date());
  setPageFields();
  window.gtag('config', measurementId, {
    send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
  });
  // gtag.js itself is the Termly-classified tag rendered by SiteAnalytics; Termly releases it, and it then reads
  // the queue above. Nothing here loads a script.
  loadedFor = measurementId;
}

function setPageFields() {
  if (!page?.location || !window.gtag) return;
  window.gtag('set', { page_location: page.location, page_referrer: page.referrer, page_title: pageTitleFor(page.location) });
}

/** A new address was opened (first load or in-app navigation). `previous` is the address we were on before. */
export function enterPage(href: string, previous: string | null): void {
  const origin = new URL(href).origin;
  navigation += 1;
  page = {
    location: sanitizePageUrl(href),
    referrer: previous === null ? sanitizeReferrer(document.referrer, origin) : sanitizeReferrer(previous, origin),
    navigation,
  };
}

/** Bring GA in line with the current page and Termly's live consent; sends this page's view once. */
export function syncGa(measurementId: string | null): void {
  if (!measurementId || typeof window === 'undefined' || !page) return;
  const reportable = analyticsAllowed() && page.location !== null;
  window[`ga-disable-${measurementId}`] = !reportable;
  if (!reportable) {
    if (loadedFor) window.gtag?.('consent', 'update', { analytics_storage: 'denied', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied' });
    return;
  }
  if (loadedFor !== measurementId) load(measurementId);
  else {
    window.gtag?.('consent', 'update', consentFields(readTermlyConsent().advertising));
    setPageFields();
  }
  if (pageViewSentFor === page.navigation) return;
  pageViewSentFor = page.navigation;
  window.gtag?.('event', 'page_view', {
    page_location: page.location, page_referrer: page.referrer, page_title: pageTitleFor(page.location!),
  });
}

export type GaEventParams = Record<string, string | number | boolean | Record<string, string | number>[]>;

/** A key event on the current page; dropped unless GA is loaded, consent is live and the page is reportable. */
export function sendGaEvent(measurementId: string | null, name: string, params: GaEventParams = {}): boolean {
  if (!measurementId || typeof window === 'undefined' || loadedFor !== measurementId || !page?.location) return false;
  if (!analyticsAllowed() || window[`ga-disable-${measurementId}`]) return false;
  window.gtag?.('event', name, { ...params, page_location: page.location, page_title: pageTitleFor(page.location) });
  return true;
}

export type GaCheckoutIds = { clientId: string; sessionId: string };
const CLIENT_ID = /^[0-9]{1,20}\.[0-9]{1,20}$/;
const SESSION_ID = /^[0-9]{1,20}$/;

/**
 * The GA client and session IDs for the server's purchase report, read with Google's own `gtag('get')` (never by
 * parsing cookies). Null without live consent, on a page GA is paused for, or when gtag does not answer in time.
 */
export function readGaCheckoutIds(measurementId: string | null, timeoutMs = 800): Promise<GaCheckoutIds | null> {
  if (!measurementId || typeof window === 'undefined' || loadedFor !== measurementId || !window.gtag) return Promise.resolve(null);
  if (!analyticsAllowed() || window[`ga-disable-${measurementId}`]) return Promise.resolve(null);
  const field = (name: 'client_id' | 'session_id') => new Promise<string | null>(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    window.gtag!('get', measurementId, name, (value: unknown) => {
      clearTimeout(timer);
      resolve(typeof value === 'string' || typeof value === 'number' ? String(value) : null);
    });
  });
  return Promise.all([field('client_id'), field('session_id')]).then(([clientId, sessionId]) =>
    clientId && sessionId && CLIENT_ID.test(clientId) && SESSION_ID.test(sessionId) && analyticsAllowed()
      ? { clientId, sessionId } : null);
}

/** Test hook: forget the loaded state between tests. */
export function resetGaForTests(): void {
  loadedFor = null;
  page = null;
  navigation = 0;
  pageViewSentFor = -1;
}
