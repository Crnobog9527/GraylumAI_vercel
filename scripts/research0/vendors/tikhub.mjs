// TikHub (https://docs.tikhub.io, https://api.tikhub.io/openapi.json).
// Per-endpoint USD prices from TikHub's public price list; responses carry no
// cost. Failed (non-200) requests are documented as not billed, but an HTTP 200
// wrapping an upstream error is billed, so every call reserves a worst case of
// several times the listed price. The free /tikhub/user/get_user_info balance
// is read before and after the run to measure the actual charge.

import { count } from '../metrics.mjs';
import { normalizeTikhub, tikhubFailed } from './tikhubShapes.mjs';

const BASE = 'https://api.tikhub.io';

function get(pathname, params, listedUsd, margin = 3) {
  const url = new URL(`${BASE}${pathname}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  return { method: 'GET', url: url.toString(), worstCaseUsd: listedUsd * margin, listedUsd };
}

function post(pathname, body, listedUsd, margin = 3) {
  return { method: 'POST', url: `${BASE}${pathname}`, body, worstCaseUsd: listedUsd * margin, listedUsd };
}

// Paths shared with AIsa's TikHub resale so the two routes are comparable.
export const TIKHUB_PATHS = {
  Q02: ['POST', '/douyin/search/fetch_video_search_v5', { keyword: '露营装备', offset: 0, page: 1, search_id: '', backtrace: '' }],
  Q03: ['GET', '/xiaohongshu/app_v2/search_notes', { keyword: '极简护肤', page: 1, sort_type: 'general' }],
  Q04: ['GET', '/bilibili/web/fetch_user_profile', { uid: '456664753' }],
  Q05: ['GET', '/weibo/app/fetch_user_timeline', { uid: '2803301701', page: 1, filter_type: 'all' }],
  Q06: ['GET', '/tiktok/app/v3/handler_user_profile', { unique_id: 'natgeo' }],
  Q07: ['GET', '/tiktok/app/v3/fetch_video_search_result', { keyword: 'camping gear', offset: 0, count: 20, sort_type: 0, publish_time: 0, region: 'US' }],
  Q08: ['GET', '/youtube/web_v2/get_channel_videos', { channel_id: 'UCLA_DiR1FfKNvjuUpBHmylQ', need_format: 'true' }],
  Q09: ['GET', '/twitter/web/fetch_user_profile', { screen_name: 'NASA' }],
  Q10: ['GET', '/instagram/v2/fetch_user_posts', { username: 'natgeo' }],
};

// Listed TikHub prices (USD per successful call). Q02 v5 and Q06 app/v3 are not
// in the list we read; AIsa's resale price / 1.45 gives 0.01 and 0.001, and a
// larger margin covers that inference.
const LISTED = { Q02: [0.01, 5], Q03: [0.01, 3], Q04: [0.001, 3], Q05: [0.001, 3], Q06: [0.001, 5],
  Q07: [0.001, 3], Q08: [0.001, 3], Q09: [0.001, 3], Q10: [0.002, 3] };

export const tikhub = {
  id: 'tikhub',
  label: 'TikHub',
  keyEnv: 'TIKHUB_API_KEY',
  maxCalls: 12,
  maxUsd: 1,
  timeoutMs: 60_000,
  steps(query) {
    const route = TIKHUB_PATHS[query.id];
    if (!route) return { notSupported: 'TikHub has no general web search endpoint' };
    const [method, pathname, params] = route;
    const [listed, margin] = LISTED[query.id];
    return [method === 'POST' ? post(`/api/v1${pathname}`, params, listed, margin) : get(`/api/v1${pathname}`, params, listed, margin)];
  },
  balance: {
    spec: () => ({ method: 'GET', url: `${BASE}/api/v1/tikhub/user/get_user_info`, worstCaseUsd: 0, documentedFree: true }),
    read(json) {
      const paid = count(json, ['user_data.balance', 'data.user_data.balance']);
      const free = count(json, ['user_data.free_credit', 'data.user_data.free_credit']);
      return paid === undefined ? null : paid + (free ?? 0);
    },
  },
  authorize(spec, key) {
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (spec.body === undefined) return { url: spec.url, init: { method: spec.method, headers } };
    return { url: spec.url, init: { method: spec.method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) } };
  },
  isFailure: tikhubFailed,
  failureReason: json => String(json?.code ?? json?.detail?.code ?? 'VENDOR_ERROR'),
  // No per-call cost in the response; the balance delta is the official figure.
  reportedCostUsd: () => null,
  kind: query => query.type,
  normalize: normalizeTikhub,
};
