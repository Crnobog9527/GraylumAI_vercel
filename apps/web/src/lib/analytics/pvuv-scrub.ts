/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { isSensitivePath } from './routes';

/**
 * ANALYTICS-PVUV: what the pvuv.ai script may send. The script has no "before send" hook, so pvuv.ts wraps fetch and
 * sendBeacon for pvuv.ai's hosts and passes every body through here. An address keeps its origin, its path and `utm_*`
 * values; every other query parameter and the fragment go. A referrer and the stored first touch (`_pv_ft`) get the same
 * treatment. A path that looks like it carries an email address or a one-time token is not reported at all.
 */
const UTM_PARAM = /^utm_[a-z_]{1,30}$/;
const UTM_VALUE_MAX = 120;
const EMAIL_LIKE = /[^/\s]+(?:@|%40)[^/\s]+/i;
// A long path segment made of token characters (hex, base64url, JWT parts): an invite, reset or share key.
const TOKEN_LIKE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{32,}$/;

/** Logged-in and money pages: the script is never loaded there, and nothing about them is ever forwarded. */
const PRIVATE_PREFIXES = ['/app', '/admin', '/account', '/checkout', '/billing', '/api'];

export function isPvuvPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (isSensitivePath(path)) return false;
  if (PRIVATE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false;
  if (EMAIL_LIKE.test(path)) return false;
  return !path.split('/').some(segment => TOKEN_LIKE_SEGMENT.test(segment));
}

function decodeSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** The page address with origin, path and `utm_*` only; null when this address must not be reported. */
export function scrubPvuvUrl(href: unknown): string | null {
  if (typeof href !== 'string' || !href) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!isPvuvPath(decodeSafe(url.pathname))) return null;
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (UTM_PARAM.test(name) && value.length <= UTM_VALUE_MAX && !EMAIL_LIKE.test(value)) kept.append(name, value);
  }
  const query = kept.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/** A referrer: another site keeps origin only; our own pages go through the page rules (an unreportable one becomes the origin). */
export function scrubPvuvReferrer(referrer: unknown, ownOrigin: string): string | undefined {
  if (typeof referrer !== 'string' || !referrer) return undefined;
  let url: URL;
  try { url = new URL(referrer); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.origin !== ownOrigin) return url.origin;
  return scrubPvuvUrl(referrer) ?? url.origin;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function scrubFirstTouch(ft: unknown, ownOrigin: string): unknown {
  if (!isObject(ft)) return ft;
  const next: Json = { ...ft };
  const referrer = scrubPvuvReferrer(ft.r, ownOrigin);
  if (referrer) next.r = referrer; else delete next.r;
  return next;
}

/** One event or verdict request body. Null = drop it (unreportable page). */
function scrubEvent(event: unknown, ownOrigin: string): Json | null {
  if (!isObject(event)) return null;
  const next: Json = { ...event };
  if ('u' in next) {
    const page = scrubPvuvUrl(next.u);
    if (!page) return null;
    next.u = page;
  }
  if ('r' in next) {
    const referrer = scrubPvuvReferrer(next.r, ownOrigin);
    if (referrer) next.r = referrer; else delete next.r;
  }
  if ('ft' in next) next.ft = scrubFirstTouch(next.ft, ownOrigin);
  // Custom properties are ours alone and the page sends none today; one that looks like an email is dropped regardless.
  if (isObject(next.p) && EMAIL_LIKE.test(JSON.stringify(next.p))) delete next.p;
  return next;
}

/** The text body of a request to pvuv.ai, cleaned. Null = send nothing; an unreadable body is not sent either. */
export function scrubPvuvBody(body: string, ownOrigin: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (Array.isArray(parsed)) {
    const events = parsed.map(event => scrubEvent(event, ownOrigin)).filter((event): event is Json => event !== null);
    return events.length ? JSON.stringify(events) : null;
  }
  const event = scrubEvent(parsed, ownOrigin);
  return event ? JSON.stringify(event) : null;
}

/** The raw `_pv_ft` cookie value (JSON) with its referrer cleaned. Null when it cannot be read: the caller deletes it. */
export function scrubFirstTouchCookie(raw: string, ownOrigin: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? JSON.stringify(scrubFirstTouch(parsed, ownOrigin)) : null;
  } catch {
    return null;
  }
}

/** Cookies the script keeps (visitor, session, first touch, verdict, user, and its cookie-domain probe). */
export const PVUV_COOKIES = ['_pv_id', '_pv_sid', '_pv_ft', '_pv_v', '_pv_uid', '_pv_t'];

export function isPvuvHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'pvuv.ai' || host.endsWith('.pvuv.ai');
}
