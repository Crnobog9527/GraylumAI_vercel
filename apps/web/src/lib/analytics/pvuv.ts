/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { analyticsAllowed } from './consent';
import { isPvuvHost, isPvuvPath, PVUV_COOKIES, scrubFirstTouchCookie, scrubPvuvBody } from './pvuv-scrub';

/**
 * ANALYTICS-PVUV (Owner 2026-11-22): the pvuv.ai script in the browser. It is inserted only when a site id is configured,
 * our consent module allows statistics and the page is a public one, after `load` and when the browser is idle. Page views
 * are automatic. pvuv.ai tells visitors apart itself (cookies `_pv_id`, `_pv_sid`, `_pv_ft`).
 * Everything the script sends passes through pvuv-scrub.ts first (fetch and sendBeacon are wrapped for pvuv.ai's hosts) and
 * is dropped while statistics are not allowed. A running script cannot be unloaded, so a refusal clears its cookies and
 * storage and reloads the page, where it is no longer added. After login the account's opaque id (never the email) is
 * passed with `pvuv('identify', id)`.
 */
export const PVUV_SCRIPT_URL = 'https://www.pvuv.ai/f.js';
export const PVUV_API_URL = 'https://in.pvuv.ai';
// The script's own exclude list (regular expressions built from `*` patterns), a second lock beside pvuv-scrub.ts.
const EXCLUDE = ['/app', '/app/*', '/admin', '/admin/*', '/account/*', '/checkout/*', '/billing/*', '/auth/*',
  '/verify-email', '/reset-password', '/api/*'].join(',');

type PvuvFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
declare global {
  interface Window { pvuv?: PvuvFn }
}

let wrapped = false;
let inserted = false;
let scheduled = false;
let pendingUser: string | null = null;

function ownOrigin(): string {
  return window.location.origin;
}

/** Wraps fetch and sendBeacon once: a request to pvuv.ai is cleaned, or not sent while statistics are not allowed. */
export function installPvuvScrubber(): void {
  if (wrapped || typeof window === 'undefined') return;
  wrapped = true;
  const clean = (body: unknown): string | null => {
    if (!analyticsAllowed() || typeof body !== 'string') return null;
    return scrubPvuvBody(body, ownOrigin());
  };
  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let host = '';
      try { host = new URL(url, window.location.href).hostname; } catch { /* not an address */ }
      if (!isPvuvHost(host)) return originalFetch(input, init);
      const body = clean(init?.body);
      if (body === null) return Promise.resolve(new Response('{}', { status: 200 }));
      return originalFetch(input, { ...init, body });
    }) as typeof window.fetch;
  }
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      let host = '';
      try { host = new URL(String(url), window.location.href).hostname; } catch { /* not an address */ }
      if (!isPvuvHost(host)) return originalBeacon(url, data);
      const body = clean(data);
      return body === null ? true : originalBeacon(url, body);
    };
  }
}

function cookieDomains(): string[] {
  const parts = window.location.hostname.split('.');
  const domains = [''];
  for (let i = 0; i < parts.length - 1; i += 1) domains.push(`; domain=.${parts.slice(i).join('.')}`);
  return domains;
}

/** The widest domain this host may set a cookie for, found the way the script finds it; '' = host-only. */
function parentCookieDomain(): string {
  const host = window.location.hostname;
  if (/^[\d.]+$/.test(host) || !host.includes('.')) return '';
  const parts = host.split('.');
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const candidate = parts.slice(i).join('.');
    document.cookie = `_pv_gt=1; path=/; domain=.${candidate}; Max-Age=60; SameSite=Lax`;
    if (readCookie('_pv_gt')) {
      document.cookie = `_pv_gt=; path=/; domain=.${candidate}; Max-Age=0`;
      return candidate;
    }
  }
  return '';
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** `_pv_ft` keeps the raw referrer from the first visit; rewrite it with the same clean-up as the requests. */
export function cleanFirstTouchCookie(): void {
  try {
    const raw = readCookie('_pv_ft');
    if (!raw) return;
    const cleaned = scrubFirstTouchCookie(raw, ownOrigin());
    if (cleaned === raw) return;
    for (const domain of cookieDomains()) document.cookie = `_pv_ft=; Max-Age=0; path=/${domain}`;
    if (cleaned) {
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      const parent = parentCookieDomain();
      document.cookie = `_pv_ft=${encodeURIComponent(cleaned)}; Max-Age=${396 * 86400}; path=/; SameSite=Lax${secure}${parent ? `; domain=.${parent}` : ''}`;
    }
  } catch {
    // No cookies: nothing to rewrite.
  }
}

/** The script's cookies and storage, removed on this host and its parent domains. Used on refusal and when the account signs out. */
export function clearPvuvStorage(names: readonly string[] = PVUV_COOKIES): void {
  try {
    for (const name of names) {
      for (const domain of cookieDomains()) document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
    }
    if (names.includes('_pv_id')) {
      for (const key of Object.keys(window.localStorage)) if (key.startsWith('_pv')) window.localStorage.removeItem(key);
    }
  } catch {
    // No document or storage (tests, workers): nothing to remove.
  }
}

function whenIdle(run: () => void) {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4000 });
  else setTimeout(run, 1);
}

function insertScript(site: string) {
  scheduled = false;
  // Re-check at the moment of insertion: consent or the page may have changed while waiting for idle time.
  if (inserted || !analyticsAllowed() || !isPvuvPath(window.location.pathname)) return;
  installPvuvScrubber();
  const queue: PvuvFn = Object.assign((...args: unknown[]) => { (queue.q ??= []).push(args); }, { q: [] as unknown[][] });
  window.pvuv = queue;
  const script = document.createElement('script');
  script.src = PVUV_SCRIPT_URL;
  script.defer = true;
  script.setAttribute('data-site', site);
  script.setAttribute('data-api', PVUV_API_URL);
  script.setAttribute('data-exclude', EXCLUDE);
  script.onload = () => cleanFirstTouchCookie();
  document.head.appendChild(script);
  inserted = true;
  if (pendingUser) { window.pvuv?.('identify', pendingUser); pendingUser = null; }
}

/**
 * Bring pvuv.ai in line with consent and the current page. Called on every address change and consent change.
 * `reload` runs only when a running script has to go because consent was refused or withdrawn.
 */
export function syncPvuv(site: string | null, pathname: string, reload: () => void = () => window.location.reload()): void {
  if (!site || typeof window === 'undefined') return;
  if (!analyticsAllowed()) {
    if (inserted) {
      clearPvuvStorage();
      inserted = false;
      pendingUser = null;
      reload();
    }
    return;
  }
  if (inserted || scheduled || !isPvuvPath(pathname)) return;
  scheduled = true;
  const start = () => whenIdle(() => insertScript(site));
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/** The signed-in account's opaque id (never an email). Queued until the script is on the page; ignored without consent. */
export function identifyPvuv(userId: string | null | undefined): void {
  if (typeof window === 'undefined' || !userId || !analyticsAllowed()) return;
  if (inserted && window.pvuv) window.pvuv('identify', userId);
  else pendingUser = userId;
}

/** Sign-out: the script's stored account id goes (the visitor id stays; that is the same browser). */
export function forgetPvuvUser(): void {
  pendingUser = null;
  clearPvuvStorage(['_pv_uid']);
}

/** Test hook. */
export function resetPvuvForTests(): void {
  wrapped = false;
  inserted = false;
  scheduled = false;
  pendingUser = null;
}
