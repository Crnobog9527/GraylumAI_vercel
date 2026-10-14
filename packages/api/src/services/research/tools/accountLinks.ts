/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Profile links → (platform, canonical account) for benchmark authorization (plan §2.1 `user_message`).
// The host parses links itself and only trusts whole profile links, never substrings of the message.
import { accountPatternFor } from '../vendors/tikhub';
import type { SocialPlatform } from '../vendors/types';

export interface CanonicalAccount {
  platform: SocialPlatform;
  account: string;
}

/** Handles on these platforms are case-insensitive, so the lower-case form is the canonical one. */
const CASE_INSENSITIVE: ReadonlySet<SocialPlatform> = new Set(['tiktok', 'x', 'instagram']);

/** First path segments that are site pages, not accounts. */
const X_RESERVED = new Set(['home', 'explore', 'i', 'search', 'settings', 'intent', 'share', 'hashtag',
  'messages', 'notifications', 'compose', 'login', 'signup', 'tos', 'privacy']);
const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'direct']);

const hostIs = (host: string, ...domains: string[]) => domains.some(domain => host === domain || host === `www.${domain}`
  || host === `m.${domain}` || host === `mobile.${domain}`);

/**
 * Account candidate from one URL; null when it is not a recognised profile link. The path must be the
 * profile itself: a post, video or sub-page link (x.com/a/status/1, tiktok.com/@a/video/1) does not
 * confirm the account.
 */
function fromUrl(url: URL): { platform: SocialPlatform; raw: string } | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
  const only = (length: number) => parts.length === length;
  if (hostIs(host, 'tiktok.com')) {
    return only(1) && parts[0].startsWith('@') ? { platform: 'tiktok', raw: parts[0].slice(1) } : null;
  }
  if (hostIs(host, 'x.com', 'twitter.com')) {
    return only(1) && !X_RESERVED.has(parts[0].toLowerCase()) ? { platform: 'x', raw: parts[0] } : null;
  }
  if (hostIs(host, 'instagram.com')) {
    return only(1) && !INSTAGRAM_RESERVED.has(parts[0].toLowerCase()) ? { platform: 'instagram', raw: parts[0] } : null;
  }
  if (hostIs(host, 'youtube.com')) return only(2) && parts[0] === 'channel' ? { platform: 'youtube', raw: parts[1] } : null;
  if (host === 'space.bilibili.com') return only(1) ? { platform: 'bilibili', raw: parts[0] } : null;
  if (hostIs(host, 'weibo.com', 'weibo.cn')) return only(2) && parts[0] === 'u' ? { platform: 'weibo', raw: parts[1] } : null;
  return null;
}

/**
 * Canonical identifier for an account the model names (bare id, `@handle`, or a profile link).
 * null when it cannot be a valid account on that platform.
 */
export function canonicalAccount(platform: SocialPlatform, value: string): string | null {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseProfileLink(trimmed);
    return parsed?.platform === platform ? parsed.account : null;
  }
  const pattern = accountPatternFor(platform);
  const bare = CASE_INSENSITIVE.has(platform) && trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!pattern?.test(bare)) return null;
  return CASE_INSENSITIVE.has(platform) ? bare.toLowerCase() : bare;
}

/** One profile link → canonical account; null for non-profile links and unsupported formats. */
export function parseProfileLink(link: string): CanonicalAccount | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Only the platform's normal origin counts: no credentials, no custom port.
  if (url.username || url.password || url.port) return null;
  let found: ReturnType<typeof fromUrl>;
  try { found = fromUrl(url); } catch { return null; }
  if (!found) return null;
  const account = canonicalAccount(found.platform, found.raw);
  return account === null ? null : { platform: found.platform, account };
}

const LINK = /https?:\/\/[^\s<>"'，。；、）)\]】,;!?]+/gi;
/** Sentence-ending dots or colons are not part of a link; no supported handle can end with them. */
const TRAILING = /[.:]+$/;

/** Every distinct profile account linked in a message, in order of appearance. */
export function profileLinksIn(message: string): CanonicalAccount[] {
  const seen = new Set<string>();
  const found: CanonicalAccount[] = [];
  for (const match of message.matchAll(LINK)) {
    const parsed = parseProfileLink(match[0].replace(TRAILING, ''));
    if (!parsed) continue;
    const key = `${parsed.platform}:${parsed.account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(parsed);
  }
  return found;
}
