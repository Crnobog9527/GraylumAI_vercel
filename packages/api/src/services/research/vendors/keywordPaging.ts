/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-1a: next pages of a keyword search, checked against real TikHub responses recorded on 2026-10-23
// (TikTok offset 20 → data.cursor 40; Douyin business_config.next_page {cursor, search_id}; Xiaohongshu next_page with
// search_id and search_session_id; YouTube data.continuation_token). The cursor travels as one opaque string; it is
// checked strictly before any call (a wrong one may still be billed). X has no verified keyword paging: no cursor.
import { first } from './fields';
import type { SocialPlatform } from './types';

type Raw = Record<string, unknown>;

const PATTERNS: Partial<Record<SocialPlatform, RegExp>> = {
  // The next offset.
  tiktok: /^[1-9]\d{0,4}$/,
  // `<cursor>:<search_id>`.
  douyin: /^[1-9]\d{0,4}:[0-9A-Za-z]{8,64}$/,
  // `<page>:<search_id>:<search_session_id>`.
  xiaohongshu: /^([2-9]|[1-9]\d):[0-9A-Za-z]{8,64}:[0-9A-Za-z]{8,64}$/,
  // YouTube's continuation token (base64url with %-escapes, ~600 characters).
  youtube: /^[A-Za-z0-9_\-%=]{16,2000}$/,
};

/** Whether `cursor` can be a next-page cursor of a keyword search on `platform`. */
export function validKeywordCursor(platform: SocialPlatform, cursor: string): boolean {
  return PATTERNS[platform]?.test(cursor) === true;
}

const int = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value
  : typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null);
const more = (value: unknown) => value === true || value === 1 || value === '1';

/** The page position a cursor stands for (offset, cursor or page number); null for YouTube's opaque token. */
function position(platform: SocialPlatform, cursor: string): number | null {
  return platform === 'youtube' ? null : Number(cursor.split(':')[0]);
}

/**
 * The next page's cursor, only when the supplier says there is one, it has the expected form and it moves forward from
 * `current` (the cursor this answer was requested with): a cursor that does not advance would pay for the same page again.
 */
export function keywordNextCursor(json: unknown, platform: SocialPlatform, current?: string): string | undefined {
  const data = (first(json, ['data']) ?? null) as Raw | null;
  if (!data || typeof data !== 'object') return undefined;
  let cursor: string | undefined;
  if (platform === 'tiktok') {
    const offset = int(data.cursor);
    cursor = more(data.has_more) && offset !== null ? String(offset) : undefined;
  } else if (platform === 'douyin') {
    const config = data.business_config as Raw | undefined;
    const next = config?.next_page as Raw | undefined;
    const offset = int(next?.cursor);
    cursor = more(config?.has_more) && offset !== null && typeof next?.search_id === 'string'
      ? `${offset}:${next.search_id}` : undefined;
  } else if (platform === 'xiaohongshu') {
    const page = int(data.next_page);
    cursor = page !== null && typeof data.search_id === 'string' && typeof data.search_session_id === 'string'
      ? `${page}:${data.search_id}:${data.search_session_id}` : undefined;
  } else if (platform === 'youtube') {
    cursor = typeof data.continuation_token === 'string' ? data.continuation_token : undefined;
  }
  if (cursor === undefined || !validKeywordCursor(platform, cursor) || cursor === current) return undefined;
  const from = current === undefined ? (platform === 'xiaohongshu' ? 1 : 0) : position(platform, current);
  const to = position(platform, cursor);
  return from !== null && to !== null && to <= from ? undefined : cursor;
}

/** Request parameters a checked cursor sets on the platform's keyword search (overriding its first-page values). */
export function keywordCursorParams(platform: SocialPlatform, cursor: string | undefined): Record<string, string | number> {
  if (cursor === undefined || !validKeywordCursor(platform, cursor)) return {};
  const parts = cursor.split(':');
  switch (platform) {
    case 'tiktok': return { offset: Number(cursor) };
    case 'douyin': return { cursor: Number(parts[0]), search_id: parts[1]! };
    case 'xiaohongshu': return { page: Number(parts[0]), search_id: parts[1]!, search_session_id: parts[2]! };
    case 'youtube': return { continuation_token: cursor };
    default: return {};
  }
}
