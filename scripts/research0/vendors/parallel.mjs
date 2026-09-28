// Parallel Search (https://docs.parallel.ai), Owner-provided key 2026-09-28.
// POST /v1/search with an objective and one query, mode "advanced" (listed
// at 5 USD per 1,000 requests). Responses carry an official usage count
// (sku_search), not a price, so the booked worst case stays 3x the list price.

import { list, text, timestamp } from '../metrics.mjs';

const SEARCH = 'https://api.parallel.ai/v1/search';
const LIST_USD = 0.005;

export const parallel = {
  id: 'parallel',
  label: 'Parallel',
  keyEnv: 'PARALLEL_API_KEY',
  maxCalls: 25,
  maxUsd: 1,
  timeoutMs: 60_000,
  steps(query) {
    if (!query.webQuery) return { notSupported: 'not in the Parallel test plan' };
    const objective = query.region === 'cn'
      ? `为中文内容创作者查找与"${query.webQuery}"相关的最新、可靠的中文网页信息`
      : `Find recent, reliable web pages about: ${query.webQuery}`;
    return [{ method: 'POST', url: SEARCH, worstCaseUsd: LIST_USD * 3,
      body: { objective, search_queries: [query.webQuery], mode: 'advanced' } }];
  },
  authorize(spec, key) {
    return { url: spec.url, init: { method: spec.method,
      headers: { 'x-api-key': key, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) } };
  },
  isFailure: json => !Array.isArray(json?.results),
  failureReason: json => text(json, ['error.message', 'error', 'detail', 'message']) ?? 'VENDOR_ERROR',
  reportedCostUsd: () => null,
  reportedRaw(json) {
    const usage = Array.isArray(json?.usage) ? json.usage : [];
    return usage.length === 0 ? null : usage.map(item => `${item?.name}=${item?.count}`).join(',');
  },
  kind: () => 'web',
  normalize: json => list(json, ['results']).map(item => ({
    url: text(item, ['url']),
    title: text(item, ['title']),
    snippet: Array.isArray(item?.excerpts) ? text(item, ['excerpts.0']) : undefined,
    publishedAt: timestamp(item, ['publish_date']),
  })),
};
