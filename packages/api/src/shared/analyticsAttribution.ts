/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * First-source attribution shared by the browser and the server (ANALYTICS plan §3.1 UTM rule, §3.2, O8, O9).
 * Only registered UTM values are kept (a visitor-supplied value can carry a name or an email address), the
 * referrer is a host name only, and the landing path is a route template. The server re-checks every field.
 * Add a campaign code to UTM_REGISTRY before publishing a new promotion link.
 */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
/** What an unregistered UTM value is stored as: the value itself can carry a name or an email address. */
export const OTHER_UTM = 'other';

export const UTM_REGISTRY: Record<UtmKey, readonly string[]> = {
  utm_source: [
    'youtube', 'xiaohongshu', 'reddit', 'newsletter', 'google', 'bing', 'facebook', 'instagram', 'threads', 'x',
    'tiktok', 'douyin', 'bilibili', 'wechat', 'weibo', 'zhihu', 'linkedin', 'telegram', 'discord', 'email',
  ],
  utm_medium: ['social', 'video', 'email', 'cpc', 'paid_social', 'referral', 'affiliate', 'organic', 'community'],
  // Our own campaign codes; none are published yet.
  utm_campaign: [],
  utm_content: [],
  utm_term: [],
};

/** The registered UTM pairs of a query string, in a fixed order; unregistered keys and values are dropped. */
export function registeredUtm(search: string): [UtmKey, string][] {
  const params = new URLSearchParams(search);
  const kept: [UtmKey, string][] = [];
  for (const key of UTM_KEYS) {
    const value = params.get(key)?.trim().toLowerCase();
    if (value && UTM_REGISTRY[key].includes(value)) kept.push([key, value]);
  }
  return kept;
}

export type SignupAttribution = Partial<Record<UtmKey, string>> & {
  referrer_host?: string;
  landing_path?: string;
  first_seen_at: string;
};

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// Route templates only: lowercase words or [paramName]; a segment that looks like a record ID is refused.
const SEGMENT = /^(?:[a-z][a-z0-9-]{0,40}|\[[a-zA-Z]{1,30}\])$/;
const ID_LIKE = /\d{4,}|[0-9a-f]{8}-/;
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

function templatePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 120 || !value.startsWith('/')) return null;
  if (value === '/') return value;
  const segments = value.slice(1).split('/');
  return segments.every(part => SEGMENT.test(part) && !ID_LIKE.test(part)) ? value : null;
}

/** A clean attribution record, or null when nothing usable remains. Unknown keys and values are dropped. */
export function parseSignupAttribution(raw: unknown, now = Date.now()): SignupAttribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const seen = typeof input.first_seen_at === 'string' ? Date.parse(input.first_seen_at) : NaN;
  if (!Number.isFinite(seen) || seen > now + 60_000 || now - seen > MAX_AGE_MS) return null;
  const result: SignupAttribution = { first_seen_at: new Date(seen).toISOString() };
  for (const key of UTM_KEYS) {
    const value = typeof input[key] === 'string' ? (input[key] as string).trim().toLowerCase() : '';
    // A visit that carried a UTM value we do not recognise is grouped as "other" (plan O9), never as direct.
    if (value) result[key] = UTM_REGISTRY[key].includes(value) ? value : OTHER_UTM;
  }
  const host = typeof input.referrer_host === 'string' ? input.referrer_host.trim().toLowerCase() : '';
  if (HOST.test(host)) result.referrer_host = host;
  const path = templatePath(input.landing_path);
  if (path) result.landing_path = path;
  return result;
}
