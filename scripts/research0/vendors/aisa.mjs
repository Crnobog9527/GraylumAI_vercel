// AIsa (https://aisa.one/docs, https://aisa.one/api). Pay-as-you-go is billed
// at the listed per-call price ("1×"). Chinese platforms, TikTok, YouTube and
// Instagram are TikHub resold under /apis/v1/tikhub/...; web search uses the
// Tavily resale. Responses carry no AIsa charge. The account balance endpoint
// exists but its own price is undocumented, so it is not called.

import { list, text, timestamp } from '../metrics.mjs';
import { TIKHUB_PATHS } from './tikhub.mjs';
import { normalizeTikhub, tikhubFailed } from './tikhubShapes.mjs';

const BASE = 'https://api.aisa.one/apis/v1';
const MARGIN = 3;

// Listed AIsa prices (USD per call) from https://aisa.one/api catalogue pages.
const LISTED = { Q01: 0.0096, Q02: 0.0145, Q03: 0.0145, Q04: 0.00145, Q05: 0.00145, Q06: 0.00145,
  Q07: 0.00145, Q08: 0.00145, Q10: 0.0029 };
const UNSUPPORTED = {
  Q09: 'X profile (/twitter/user/info) has no listed price and TikHub Twitter is not in the AIsa catalogue',
};

function spec(query) {
  const worstCaseUsd = LISTED[query.id] * MARGIN;
  if (query.id === 'Q01') {
    return { method: 'POST', url: `${BASE}/tavily/search`, worstCaseUsd,
      body: { query: query.webQuery, search_depth: 'basic', max_results: 10 } };
  }
  const [method, pathname, params] = TIKHUB_PATHS[query.id];
  if (method === 'POST') return { method, url: `${BASE}/tikhub${pathname}`, body: params, worstCaseUsd };
  const url = new URL(`${BASE}/tikhub${pathname}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  return { method, url: url.toString(), worstCaseUsd };
}

export const aisa = {
  id: 'aisa',
  label: 'AIsa',
  keyEnv: 'AISA_API_KEY',
  maxCalls: 10,
  maxUsd: 1,
  timeoutMs: 60_000,
  steps(query) {
    if (UNSUPPORTED[query.id]) return { notSupported: UNSUPPORTED[query.id] };
    return [spec(query)];
  },
  authorize(requestSpec, key) {
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (requestSpec.body === undefined) return { url: requestSpec.url, init: { method: requestSpec.method, headers } };
    return { url: requestSpec.url,
      init: { method: requestSpec.method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(requestSpec.body) } };
  },
  isFailure: (json, query) => (query?.platform === 'web' ? !Array.isArray(json?.results) : tikhubFailed(json)),
  failureReason: json => text(json, ['error.code', 'error.type', 'code', 'detail.code']) ?? 'VENDOR_ERROR',
  reportedCostUsd: () => null,
  kind: query => (query.platform === 'web' ? 'web' : query.type),
  normalize(json, query) {
    if (query.platform !== 'web') return normalizeTikhub(json, query);
    return list(json, ['results']).map(item => ({
      url: text(item, ['url']),
      title: text(item, ['title']),
      snippet: text(item, ['content']),
      publishedAt: timestamp(item, ['published_date', 'publishedDate']),
    }));
  },
};
