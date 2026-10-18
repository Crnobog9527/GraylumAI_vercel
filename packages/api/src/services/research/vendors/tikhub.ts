/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// TikHub social-data adapter. Routes are limited to the endpoints RESEARCH-0 verified (#457, #465);
// Douyin search v5 and Instagram posts v2 failed upstream and are deliberately absent. Responses
// carry no cost: each successful call is one unit at the frozen official price (RT-2).
import { exchange } from './http';
import { hasEmptyPostList, normalizeTikhub, tikhubBodyCode, videoNextCursor, xhsNextCursor } from './tikhubShapes';
import type {
  ResearchCallResult, SocialKind, SocialPlatform, VendorDeps, VendorRequest,
} from './types';

export const TIKHUB_BASE = 'https://api.tikhub.io/api/v1';
export const MAX_POSTS = 30;

type AccountId = 'tiktok_handle' | 'x_handle' | 'instagram_handle' | 'numeric' | 'youtube_channel' | 'xhs_user' | 'youtube_video'
  | 'douyin_sec_uid';
interface TikhubRoute {
  method: 'GET' | 'POST';
  path: string;
  /** What `account` (or, for post_detail, `postId`) must look like. */
  account?: AccountId;
  params: (input: { keyword?: string; account?: string; limit: number; cursor?: string }) => Record<string, string | number>;
}

/** `${platform}:${kind}` → verified TikHub endpoint. Absent pairs are not supported. */
export const TIKHUB_ROUTES: Partial<Record<`${SocialPlatform}:${SocialKind}`, TikhubRoute>> = {
  'douyin:keyword_posts': {
    method: 'POST', path: '/douyin/search/fetch_video_search_v2',
    params: ({ keyword }) => ({ keyword: keyword!, cursor: 0, sort_type: '0', publish_time: '0', filter_duration: '0',
      content_type: '0', search_id: '', backtrace: '' }),
  },
  // PUBLISH-MONITOR PR-4 (TikHub OpenAPI, NOT YET VERIFIED with a real call: RT-7 / staging check before release).
  // Douyin identifies a profile by its sec_user_id (the /user/<sec_uid> segment of a profile link); a wrong one may
  // still be billed, so it is checked strictly before any call. One page of the newest posts per call.
  'douyin:account_profile': {
    method: 'GET', path: '/douyin/app/v3/handler_user_profile', account: 'douyin_sec_uid',
    params: ({ account }) => ({ sec_user_id: account! }),
  },
  'douyin:account_posts': {
    method: 'GET', path: '/douyin/app/v3/fetch_user_post_videos', account: 'douyin_sec_uid',
    // TikHub documents count <= 20 for this endpoint, whatever the shared default is.
    params: ({ account, limit, cursor }) => ({ sec_user_id: account!, max_cursor: cursor === undefined ? 0 : Number(cursor),
      count: Math.min(limit, 20) }),
  },
  'xiaohongshu:keyword_posts': {
    method: 'GET', path: '/xiaohongshu/app_v2/search_notes',
    params: ({ keyword }) => ({ keyword: keyword!, page: 1, sort_type: 'general' }),
  },
  // RT-1b (TikHub OpenAPI). Only `user_id` is sent, never a share link. TikHub documents that a wrong user id still
  // answers 200 with Xiaohongshu's "服务异常" and is billed, so the id is checked strictly before any call.
  'xiaohongshu:account_profile': {
    method: 'GET', path: '/xiaohongshu/app_v2/get_user_info', account: 'xhs_user', params: ({ account }) => ({ user_id: account! }),
  },
  'xiaohongshu:account_posts': {
    // `cursor` is the previous page's last note cursor (TikHub: empty for the first request).
    method: 'GET', path: '/xiaohongshu/app_v2/get_user_posted_notes', account: 'xhs_user',
    params: ({ account, cursor }) => ({ user_id: account!, ...(cursor ? { cursor } : {}) }),
  },
  // Bilibili's profile has no follower count; followers come from a second, separately billed
  // relation call. Both paths are from TikHub's OpenAPI spec; RESEARCH-0 tested only the profile, so
  // RT-7 verifies the relation call before Bilibili can be enabled (it is not benchmark-capable yet).
  'bilibili:account_profile': {
    method: 'GET', path: '/bilibili/web/fetch_user_profile', account: 'numeric', params: ({ account }) => ({ uid: account! }),
  },
  'bilibili:account_relation': {
    method: 'GET', path: '/bilibili/web/fetch_user_relation_stat', account: 'numeric', params: ({ account }) => ({ uid: account! }),
  },
  // RT-1b (TikHub OpenAPI): newest-first uploads with absolute `created`, play and comment counts. V2 of this
  // endpoint drops the comment count, so V1 is used; a user's first page is all a benchmark needs.
  'bilibili:account_posts': {
    method: 'GET', path: '/bilibili/web/fetch_user_post_videos', account: 'numeric',
    params: ({ account, limit }) => ({ uid: account!, pn: 1, ps: limit, order: 'pubdate' }),
  },
  'weibo:account_posts': {
    method: 'GET', path: '/weibo/app/fetch_user_timeline', account: 'numeric',
    params: ({ account }) => ({ uid: account!, page: 1, filter_type: 'all' }),
  },
  'tiktok:keyword_posts': {
    method: 'GET', path: '/tiktok/app/v3/fetch_video_search_result',
    params: ({ keyword, limit }) => ({ keyword: keyword!, offset: 0, count: limit, sort_type: 0, publish_time: 0, region: 'US' }),
  },
  'tiktok:account_profile': {
    method: 'GET', path: '/tiktok/app/v3/handler_user_profile', account: 'tiktok_handle', params: ({ account }) => ({ unique_id: account! }),
  },
  'tiktok:account_posts': {
    method: 'GET', path: '/tiktok/app/v3/fetch_user_post_videos', account: 'tiktok_handle',
    params: ({ account, limit, cursor }) => ({ unique_id: account!, max_cursor: cursor === undefined ? 0 : Number(cursor),
      count: Math.min(limit, 20), sort_type: 0 }),
  },
  'youtube:keyword_posts': {
    method: 'GET', path: '/youtube/web_v2/get_general_search_v2', params: ({ keyword }) => ({ keyword: keyword!, type: 'video' }),
  },
  // Tested in RESEARCH-0. Abbreviated subscriber labels ("1.2M") stay missing, so YouTube is not
  // benchmark-capable; the profile still serves ordinary account lookups.
  'youtube:account_profile': {
    method: 'GET', path: '/youtube/web_v2/get_channel_description', account: 'youtube_channel',
    params: ({ account }) => ({ channel_id: account!, language_code: 'en', country_code: 'US' }),
  },
  // Only relative times ("18小时前") per video: publishedAt stays missing and is never derived from them.
  // The newest video is taken from this list's order (assumed newest first; RT-7 confirms it with real responses).
  'youtube:account_posts': {
    method: 'GET', path: '/youtube/web_v2/get_channel_videos', account: 'youtube_channel',
    params: ({ account }) => ({ channel_id: account!, need_format: 'true' }),
  },
  // RT-1b (TikHub OpenAPI): one video's details carry the exact channel_follower_count and an absolute publish date.
  // A benchmark reads it once per channel, for the newest video of that channel's account_posts result (RT-3b).
  'youtube:post_detail': {
    method: 'GET', path: '/youtube/web_v2/get_video_info_v2', account: 'youtube_video',
    params: ({ account }) => ({ video_id: account!, need_format: 'true' }),
  },
  'x:keyword_posts': {
    method: 'GET', path: '/twitter/web/fetch_search_timeline', params: ({ keyword }) => ({ keyword: keyword!, search_type: 'Latest' }),
  },
  'x:account_profile': {
    method: 'GET', path: '/twitter/web/fetch_user_profile', account: 'x_handle', params: ({ account }) => ({ screen_name: account! }),
  },
  'x:account_posts': {
    method: 'GET', path: '/twitter/web/fetch_user_post_tweet', account: 'x_handle', params: ({ account }) => ({ screen_name: account! }),
  },
  'instagram:account_profile': {
    method: 'GET', path: '/instagram/v1/fetch_user_info_by_username', account: 'instagram_handle',
    params: ({ account }) => ({ username: account! }),
  },
  'instagram:account_posts': {
    method: 'GET', path: '/instagram/v3/get_user_posts', account: 'instagram_handle',
    params: ({ account, limit }) => ({ username: account!, first: limit }),
  },
};

const ACCOUNT_PATTERNS: Record<AccountId, RegExp> = {
  // Platform username rules; anything else cannot exist there and must not cost a call.
  tiktok_handle: /^(?!.*\.$)[A-Za-z0-9._]{2,24}$/,
  x_handle: /^[A-Za-z0-9_]{1,15}$/,
  instagram_handle: /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/,
  numeric: /^\d{1,20}$/,
  youtube_channel: /^UC[A-Za-z0-9_-]{22}$/,
  // Xiaohongshu user ids are 24 lowercase hex characters (e.g. 61b46d790000000010008153).
  xhs_user: /^[0-9a-f]{24}$/,
  youtube_video: /^[A-Za-z0-9_-]{11}$/,
  // Douyin sec_user_id: base64url text that always starts with MS4wLjABAAAA.
  douyin_sec_uid: /^MS4wLjABAAAA[A-Za-z0-9_-]{20,120}$/,
};

export interface TikhubCall {
  platform: SocialPlatform;
  kind: SocialKind;
  keyword?: string;
  account?: string;
  /** The post to read for `post_detail` (a YouTube video id). */
  postId?: string;
  limit?: number;
  /** Next-page cursor for account_posts routes; malformed cursors are rejected before sending. */
  cursor?: string;
}

/** Account identifier rule for a platform's account routes; null when no account route exists. */
export function accountPatternFor(platform: SocialPlatform): RegExp | null {
  const route = TIKHUB_ROUTES[`${platform}:account_profile`] ?? TIKHUB_ROUTES[`${platform}:account_posts`];
  return route?.account ? ACCOUNT_PATTERNS[route.account] : null;
}

export function tikhubRouteId(platform: SocialPlatform, kind: SocialKind): string | null {
  return TIKHUB_ROUTES[`${platform}:${kind}`]?.path ?? null;
}

/** Builds the request, or the reason it must not be sent. Never contacts TikHub. */
export function buildTikhubRequest(call: TikhubCall): { request: VendorRequest } | { reason: string } {
  const route = TIKHUB_ROUTES[`${call.platform}:${call.kind}`];
  if (!route) return { reason: 'ROUTE_NOT_SUPPORTED' };
  const limit = Math.min(Math.max(Math.trunc(call.limit ?? MAX_POSTS), 1), MAX_POSTS);
  if (call.kind === 'keyword_posts') {
    const keyword = call.keyword?.trim();
    if (!keyword || [...keyword].length > 40 || /\p{Cc}/u.test(keyword)) return { reason: 'INVALID_KEYWORD' };
    return { request: requestFor(route, { keyword, limit }) };
  }
  const account = (call.kind === 'post_detail' ? call.postId : call.account)?.trim();
  if (!account || !route.account || !ACCOUNT_PATTERNS[route.account].test(account)) {
    return { reason: call.kind === 'post_detail' ? 'INVALID_POST' : 'INVALID_ACCOUNT' };
  }
  if (call.cursor !== undefined) {
    const xhsCursor = call.platform === 'xiaohongshu' && /^[0-9a-f]{24}$/.test(call.cursor);
    const videoCursor = (call.platform === 'tiktok' || call.platform === 'douyin')
      && /^(0|[1-9]\d*)$/.test(call.cursor) && Number.isSafeInteger(Number(call.cursor));
    if (call.kind !== 'account_posts' || (!xhsCursor && !videoCursor)) return { reason: 'INVALID_CURSOR' };
  }
  return { request: requestFor(route, { account, limit, ...(call.cursor ? { cursor: call.cursor } : {}) }) };
}

function requestFor(route: TikhubRoute, input: { keyword?: string; account?: string; limit: number; cursor?: string }): VendorRequest {
  const params = route.params(input);
  if (route.method === 'POST') return { method: 'POST', url: `${TIKHUB_BASE}${route.path}`, body: params };
  const url = new URL(`${TIKHUB_BASE}${route.path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  return { method: 'GET', url: url.toString() };
}

/**
 * One TikHub call. Never retried or switched to another supplier here. TikHub's per-endpoint rate
 * limit (10/s by default) is shared across serverless instances, so it is enforced by the caller
 * (RT-3, existing Upstash limiter) before this function runs; RT-1 adds no traffic of its own.
 */
export async function callTikhub(call: TikhubCall, deps: VendorDeps): Promise<ResearchCallResult> {
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const route = tikhubRouteId(call.platform, call.kind) ?? `${call.platform}:${call.kind}`;
  const base = { vendor: 'tikhub' as const, route, fetchedAt, items: [], truncated: false };
  const built = buildTikhubRequest(call);
  if ('reason' in built) {
    return { ...base, outcome: 'not_sent', reason: built.reason, httpStatus: null, supplierMayCharge: false,
      usage: { unit: 'call', units: '0' } };
  }
  const answer = await exchange(built.request, { Authorization: `Bearer ${deps.apiKey}` }, deps);
  if (answer.kind === 'unknown') {
    return { ...base, outcome: 'unknown', reason: answer.reason, httpStatus: null, supplierMayCharge: true,
      usage: { unit: 'call', units: null } };
  }
  // TikHub documents non-200 responses as not billed; a 200 with an unreadable body may be billed.
  if (answer.status !== 200) {
    return { ...base, outcome: 'failed', reason: `HTTP_${answer.status}`, httpStatus: answer.status,
      supplierMayCharge: false, usage: { unit: 'call', units: '0' } };
  }
  // A 200 whose body cannot be read is indeterminate: it may be a billed delivery. Never resend it.
  if (answer.kind === 'unreadable') {
    return { ...base, outcome: 'unknown', reason: answer.reason, httpStatus: 200, supplierMayCharge: true,
      usage: { unit: 'call', units: null } };
  }
  const code = tikhubBodyCode(answer.json);
  if (code !== 200) {
    return { ...base, outcome: 'failed', reason: `UPSTREAM_${code ?? 'UNKNOWN'}`, httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' } };
  }
  const all = normalizeTikhub(answer.json, call.platform, call.kind, call.account?.trim());
  // A recognized empty post list is a real, billed "no results" answer. A missing profile or an
  // unrecognized payload is not a delivery and is never reported as a successful, billable result.
  const listKind = call.kind === 'keyword_posts' || call.kind === 'account_posts';
  if (all.length === 0 && listKind && hasEmptyPostList(answer.json, call.platform, call.kind)) {
    return { ...base, outcome: 'ok', reason: 'NO_RESULTS', httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' } };
  }
  if (all.length === 0) {
    return { ...base, outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' } };
  }
  const limit = Math.min(Math.max(Math.trunc(call.limit ?? MAX_POSTS), 1), MAX_POSTS);
  const items = all.slice(0, limit);
  const nextCursor = call.kind !== 'account_posts' ? undefined
    : call.platform === 'xiaohongshu' ? xhsNextCursor(answer.json)
      : call.platform === 'tiktok' || call.platform === 'douyin' ? videoNextCursor(answer.json, call.cursor) : undefined;
  return { ...base, outcome: all.length > limit ? 'partial' : 'ok', reason: null, httpStatus: 200,
    supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items, truncated: all.length > limit,
    ...(nextCursor ? { nextCursor } : {}) };
}
