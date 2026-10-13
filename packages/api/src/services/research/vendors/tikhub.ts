/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// TikHub social-data adapter. Routes are limited to the endpoints RESEARCH-0 verified (#457, #465);
// Douyin search v5 and Instagram posts v2 failed upstream and are deliberately absent. Responses
// carry no cost: each successful call is one unit at the frozen official price (RT-2).
import { exchange } from './http';
import { hasEmptyPostList, normalizeTikhub, tikhubBodyCode } from './tikhubShapes';
import type {
  ResearchCallResult, SocialKind, SocialPlatform, VendorDeps, VendorRequest,
} from './types';

export const TIKHUB_BASE = 'https://api.tikhub.io/api/v1';
export const MAX_POSTS = 30;

type AccountId = 'handle' | 'numeric' | 'youtube_channel';
interface TikhubRoute {
  method: 'GET' | 'POST';
  path: string;
  /** What `account` must look like for account routes. */
  account?: AccountId;
  params: (input: { keyword?: string; account?: string; limit: number }) => Record<string, string | number>;
}

/** `${platform}:${kind}` → verified TikHub endpoint. Absent pairs are not supported. */
export const TIKHUB_ROUTES: Partial<Record<`${SocialPlatform}:${SocialKind}`, TikhubRoute>> = {
  'douyin:keyword_posts': {
    method: 'POST', path: '/douyin/search/fetch_video_search_v2',
    params: ({ keyword }) => ({ keyword: keyword!, cursor: 0, sort_type: '0', publish_time: '0', filter_duration: '0',
      content_type: '0', search_id: '', backtrace: '' }),
  },
  'xiaohongshu:keyword_posts': {
    method: 'GET', path: '/xiaohongshu/app_v2/search_notes',
    params: ({ keyword }) => ({ keyword: keyword!, page: 1, sort_type: 'general' }),
  },
  // The Bilibili profile carries no follower count; the relation endpoint is untested (RT-7).
  'bilibili:account_profile': {
    method: 'GET', path: '/bilibili/web/fetch_user_profile', account: 'numeric', params: ({ account }) => ({ uid: account! }),
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
    method: 'GET', path: '/tiktok/app/v3/handler_user_profile', account: 'handle', params: ({ account }) => ({ unique_id: account! }),
  },
  'tiktok:account_posts': {
    method: 'GET', path: '/tiktok/app/v3/fetch_user_post_videos', account: 'handle',
    params: ({ account, limit }) => ({ unique_id: account!, max_cursor: 0, count: limit, sort_type: 0 }),
  },
  'youtube:keyword_posts': {
    method: 'GET', path: '/youtube/web_v2/get_general_search_v2', params: ({ keyword }) => ({ keyword: keyword!, type: 'video' }),
  },
  'youtube:account_profile': {
    method: 'GET', path: '/youtube/web_v2/get_channel_description', account: 'youtube_channel',
    params: ({ account }) => ({ channel_id: account!, language_code: 'en', country_code: 'US' }),
  },
  'youtube:account_posts': {
    method: 'GET', path: '/youtube/web_v2/get_channel_videos', account: 'youtube_channel',
    params: ({ account }) => ({ channel_id: account!, need_format: 'true' }),
  },
  'x:keyword_posts': {
    method: 'GET', path: '/twitter/web/fetch_search_timeline', params: ({ keyword }) => ({ keyword: keyword!, search_type: 'Latest' }),
  },
  'x:account_profile': {
    method: 'GET', path: '/twitter/web/fetch_user_profile', account: 'handle', params: ({ account }) => ({ screen_name: account! }),
  },
  'x:account_posts': {
    method: 'GET', path: '/twitter/web/fetch_user_post_tweet', account: 'handle', params: ({ account }) => ({ screen_name: account! }),
  },
  'instagram:account_profile': {
    method: 'GET', path: '/instagram/v1/fetch_user_info_by_username', account: 'handle',
    params: ({ account }) => ({ username: account! }),
  },
  'instagram:account_posts': {
    method: 'GET', path: '/instagram/v3/get_user_posts', account: 'handle',
    params: ({ account, limit }) => ({ username: account!, first: limit }),
  },
};

const ACCOUNT_PATTERNS: Record<AccountId, RegExp> = {
  handle: /^[A-Za-z0-9._-]{1,64}$/,
  numeric: /^\d{1,20}$/,
  youtube_channel: /^UC[A-Za-z0-9_-]{22}$/,
};

export interface TikhubCall {
  platform: SocialPlatform;
  kind: SocialKind;
  keyword?: string;
  account?: string;
  limit?: number;
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
  const account = call.account?.trim();
  if (!account || !route.account || !ACCOUNT_PATTERNS[route.account].test(account)) return { reason: 'INVALID_ACCOUNT' };
  return { request: requestFor(route, { account, limit }) };
}

function requestFor(route: TikhubRoute, input: { keyword?: string; account?: string; limit: number }): VendorRequest {
  const params = route.params(input);
  if (route.method === 'POST') return { method: 'POST', url: `${TIKHUB_BASE}${route.path}`, body: params };
  const url = new URL(`${TIKHUB_BASE}${route.path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  return { method: 'GET', url: url.toString() };
}

/** One TikHub call. Never retried or switched to another supplier here. */
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
  if (answer.kind === 'unreadable') {
    return { ...base, outcome: 'failed', reason: answer.reason, httpStatus: 200, supplierMayCharge: true,
      usage: { unit: 'call', units: '1' } };
  }
  const code = tikhubBodyCode(answer.json);
  if (code !== 200) {
    return { ...base, outcome: 'failed', reason: `UPSTREAM_${code ?? 'UNKNOWN'}`, httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' } };
  }
  const all = normalizeTikhub(answer.json, call.platform, call.kind);
  // A recognized empty post list is a real, billed "no results" answer. A missing profile or an
  // unrecognized payload is not a delivery and is never reported as a successful, billable result.
  if (all.length === 0 && call.kind !== 'account_profile' && hasEmptyPostList(answer.json, call.platform)) {
    return { ...base, outcome: 'ok', reason: 'NO_RESULTS', httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' } };
  }
  if (all.length === 0) {
    return { ...base, outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' } };
  }
  const limit = Math.min(Math.max(Math.trunc(call.limit ?? MAX_POSTS), 1), MAX_POSTS);
  const items = all.slice(0, limit);
  return { ...base, outcome: all.length > limit ? 'partial' : 'ok', reason: null, httpStatus: 200,
    supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items, truncated: all.length > limit };
}
