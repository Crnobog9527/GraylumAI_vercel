/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-2: account search results (TikHub user search), checked against real responses recorded on
// 2026-10-23. Each result is a lead for the profile lookup, so its id is exactly what that platform's profile route
// takes (TikTok handle, Douyin sec_user_id, Xiaohongshu user id). Followers are kept only as an exact count; the
// Xiaohongshu label "Fans 77.9k" is not a count and stays missing (benchmark thresholds are judged after the profile).
import { count, findAll, has, idText, text } from './fields';
import type { ResearchItem, SocialPlatform } from './types';

export const ACCOUNT_SEARCH_FIELDS = ['id', 'name', 'handle', 'followers', 'postsCount'] as const;
const ID_PATTERNS: Partial<Record<SocialPlatform, RegExp>> = {
  tiktok: /^(?!.*\.$)[A-Za-z0-9._]{2,24}$/,
  douyin: /^MS4wLjABAAAA[A-Za-z0-9_-]{20,120}$/,
  xiaohongshu: /^[0-9a-f]{24}$/,
};

type Raw = Record<string, unknown>;

function lead(platform: SocialPlatform, values: Record<string, string | number | undefined>): ResearchItem | null {
  if (typeof values.id !== 'string' || !ID_PATTERNS[platform]?.test(values.id)) return null;
  const fields: ResearchItem['fields'] = {};
  const missing: string[] = [];
  for (const name of ACCOUNT_SEARCH_FIELDS) {
    const value = values[name];
    if (value === undefined) missing.push(name);
    else fields[name] = value;
  }
  return { fields, missing };
}

/**
 * Only the answer's own `user_list` is read: entries also carry the user's videos, whose author objects must not
 * become leads of their own. Douyin wraps each user as a JSON string under dynamic_patch.raw_data; unreadable
 * entries are skipped.
 */
function listedUsers(data: unknown): Raw[] {
  const list = (data as Raw | null)?.user_list;
  if (!Array.isArray(list)) return [];
  return list.flatMap(entry => {
    const raw = ((entry as Raw | null)?.dynamic_patch as Raw | undefined)?.raw_data;
    const direct = (entry as Raw | null)?.user_info;
    try {
      const info = (typeof raw === 'string' ? (JSON.parse(raw) as Raw).user_info : direct) as Raw | undefined;
      return info && typeof info === 'object' ? [info] : [];
    } catch {
      return [];
    }
  });
}

/** Account leads in one search answer, in the supplier's order; duplicates keep their first position. */
export function normalizeAccountSearch(data: unknown, platform: SocialPlatform): ResearchItem[] {
  let users: Array<ResearchItem | null> = [];
  if (platform === 'tiktok') {
    users = listedUsers(data).map(user => lead(platform, {
      id: idText(user, ['unique_id']), name: text(user, ['nickname']), handle: text(user, ['unique_id']),
      followers: count(user, ['follower_count']), postsCount: count(user, ['aweme_count']) }));
  } else if (platform === 'douyin') {
    users = listedUsers(data).map(user => lead(platform, {
      id: idText(user, ['sec_uid']), name: text(user, ['nickname']), handle: text(user, ['unique_id']),
      followers: count(user, ['follower_count']), postsCount: count(user, ['aweme_count']) }));
  } else if (platform === 'xiaohongshu') {
    users = findAll(data, o => has(o, 'red_id') && has(o, 'id') && has(o, 'name'), 50).map(user => lead(platform, {
      id: idText(user, ['id']), name: text(user, ['name']), handle: text(user, ['red_id']),
      followers: undefined, postsCount: undefined }));
  }
  const seen = new Set<string>();
  return users.filter((item): item is ResearchItem => {
    if (!item) return false;
    const id = String(item.fields.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
