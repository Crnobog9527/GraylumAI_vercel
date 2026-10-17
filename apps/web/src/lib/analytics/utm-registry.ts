/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * UTM values we accept (ANALYTICS plan §3.1, O9). Only values listed here are reported to GA or Vercel (and,
 * later, saved as a sign-up's first source); anything else is dropped, because a visitor-supplied value can
 * carry a name or an email address. Add a campaign code here before publishing a new promotion link.
 */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

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
