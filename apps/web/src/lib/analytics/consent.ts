/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { parseRegionCookie, REGION_COOKIE, type ConsentRegion } from './consent-region';

/**
 * Our own statistics consent (ANALYTICS-CONSENT, Owner 2026-11-07; replaces Termly's consent state). One question:
 * may non-essential statistics (GA4, Speed Insights, the stored first touch, later PostHog) run right now?
 *
 * - The region class comes from the cookie the proxy wrote on this page's response (consent-region.ts); missing = opt-in.
 * - The visitor's own choice ("接受" / "仅必要") is kept in this browser's localStorage and wins over the region default.
 * - Opt-out regions are allowed until the visitor turns statistics off; opt-in regions are denied until "接受".
 * - A Global Privacy Control signal is a refusal everywhere, whatever was stored.
 * - A choice made here (or in another tab) reaches every subscriber at once, so a withdrawal stops reporting immediately.
 *
 * Vercel Web Analytics is cookieless and records every visitor; it does not ask this module (vercel.ts).
 */
export type ConsentChoice = 'granted' | 'denied';
export type { ConsentRegion };

export type ConsentSnapshot = {
  /** Read in the browser: region, stored choice and GPC are known, so a false `analytics` is the visitor's real state. */
  ready: boolean;
  region: ConsentRegion;
  choice: ConsentChoice | null;
  gpc: boolean;
  analytics: boolean;
  /** The bar should show: an opt-in visitor who has not chosen yet, or "Cookie 设置" was opened. */
  promptOpen: boolean;
  /** Opened from "Cookie 设置" (the bar then shows the current state and can be closed without choosing). */
  reopened: boolean;
};

export const CHOICE_KEY = 'graylum.analytics.consent';

const DENIED: ConsentSnapshot = {
  ready: false, region: 'optin', choice: null, gpc: false, analytics: false, promptOpen: false, reopened: false,
};

let snapshot: ConsentSnapshot = DENIED;
let loaded = false;
let reopened = false;
const listeners = new Set<() => void>();

declare global {
  interface Navigator { globalPrivacyControl?: boolean }
}

function readCookie(name: string): string | null {
  try {
    const raw = typeof document === 'undefined' ? '' : document.cookie ?? '';
    for (const part of raw.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return decodeURIComponent(rest.join('='));
    }
  } catch {
    // Cookies unreadable: treated as unknown (opt-in).
  }
  return null;
}

function readStoredChoice(): ConsentChoice | null {
  try {
    const raw = window.localStorage?.getItem(CHOICE_KEY);
    if (!raw) return null;
    const choice = (JSON.parse(raw) as { choice?: unknown } | null)?.choice;
    return choice === 'granted' || choice === 'denied' ? choice : null;
  } catch {
    return null;
  }
}

function writeStoredChoice(choice: ConsentChoice) {
  try {
    window.localStorage?.setItem(CHOICE_KEY, JSON.stringify({ choice, at: new Date().toISOString() }));
  } catch {
    // Storage unavailable: the choice holds for this page only.
  }
}

function readGpc(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

function compute(region: ConsentRegion, choice: ConsentChoice | null, gpc: boolean): ConsentSnapshot {
  const analytics = !gpc && (choice === 'granted' || (choice === null && region === 'optout'));
  const needsChoice = region === 'optin' && choice === null && !gpc;
  return { ready: true, region, choice, gpc, analytics, promptOpen: needsChoice || reopened, reopened };
}

function publish(next: ConsentSnapshot) {
  const same = (Object.keys(next) as (keyof ConsentSnapshot)[]).every(key => next[key] === snapshot[key]);
  if (same) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== CHOICE_KEY) return;
  publish(compute(snapshot.region, readStoredChoice(), snapshot.gpc));
}

/** Reads region, stored choice and GPC once in the browser; later reads use the live in-memory state. */
function ensureLoaded(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  const region = parseRegionCookie(readCookie(REGION_COOKIE))?.region ?? 'optin';
  snapshot = compute(region, readStoredChoice(), readGpc());
  // Not allowed on this load (GPC, an earlier refusal, an opt-in visitor who has not accepted): GA cookies left from an
  // earlier consent go too, since a visitor with GPC has no button that would remove them.
  if (!snapshot.analytics) expireAnalyticsCookies();
  try { window.addEventListener?.('storage', onStorage); } catch { /* no events: this tab only */ }
}

export function analyticsAllowed(): boolean {
  ensureLoaded();
  return snapshot.analytics;
}

export function consentSnapshot(): ConsentSnapshot {
  ensureLoaded();
  return snapshot;
}

export function serverConsentSnapshot(): ConsentSnapshot {
  return DENIED;
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** GA's own cookies (`_ga`, `_ga_<id>`, legacy `_gid`) are removed on refusal, on this host and its parent domains. */
function expireAnalyticsCookies() {
  try {
    const names = document.cookie.split(';').map(part => part.trim().split('=')[0])
      .filter(name => name === '_ga' || name.startsWith('_ga_') || name === '_gid');
    const parts = window.location.hostname.split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i += 1) domains.push(`; domain=.${parts.slice(i).join('.')}`);
    for (const name of names) {
      for (const domain of domains) document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
    }
  } catch {
    // No document (tests, workers): nothing to remove.
  }
}

function choose(choice: ConsentChoice) {
  ensureLoaded();
  writeStoredChoice(choice);
  reopened = false;
  if (choice === 'denied' || snapshot.gpc) expireAnalyticsCookies();
  publish(compute(snapshot.region, choice, snapshot.gpc));
}

/** "接受": statistics may run (unless the browser sends GPC). */
export function grantConsent(): void { choose('granted'); }

/** "仅必要", or turning statistics off from "Cookie 设置": stops reporting at once. */
export function denyConsent(): void { choose('denied'); }

/** Footer and profile "Cookie 设置": shows the bar again, in every region. */
export function openConsentPreferences(): boolean {
  if (typeof window === 'undefined') return false;
  ensureLoaded();
  reopened = true;
  publish(compute(snapshot.region, snapshot.choice, snapshot.gpc));
  return true;
}

/** Closes a reopened bar without changing the choice. A first-time opt-in visitor still has to choose. */
export function closeConsentPreferences(): void {
  ensureLoaded();
  reopened = false;
  publish(compute(snapshot.region, snapshot.choice, snapshot.gpc));
}

/**
 * For a consent-aware tool added later (PostHog, ANALYTICS-POSTHOG): `optIn` runs when statistics become allowed and
 * `optOut` when they stop, starting with the current state once it is known, e.g.
 * `bindConsentedTool({ optIn: () => posthog.opt_in_capturing(), optOut: () => posthog.opt_out_capturing() })`.
 * Returns the unsubscribe function.
 */
export function bindConsentedTool(handlers: { optIn: () => void; optOut: () => void }): () => void {
  let last: boolean | null = null;
  const apply = () => {
    const current = consentSnapshot();
    if (!current.ready || current.analytics === last) return;
    last = current.analytics;
    if (current.analytics) handlers.optIn();
    else handlers.optOut();
  };
  const unsubscribe = subscribeConsent(apply);
  apply();
  return unsubscribe;
}

/** Test hook: forget everything read so far, so the next read starts from the stubbed browser. */
export function resetConsentForTests(): void {
  try { if (loaded) window.removeEventListener?.('storage', onStorage); } catch { /* stubbed window */ }
  snapshot = DENIED;
  loaded = false;
  reopened = false;
  listeners.clear();
}
