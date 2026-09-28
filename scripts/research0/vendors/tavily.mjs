// Tavily direct (https://docs.tavily.com). Owner-provided key, 2026-09-28.
// Basic search is 1 credit; the booked worst case is deliberately generous
// until the per-credit price is confirmed. Same web queries as the first
// round, so results compare with AIsa's Tavily resale and TinyFish.

import { list, text, timestamp } from '../metrics.mjs';

const SEARCH = 'https://api.tavily.com/search';
const WORST_USD = 0.03;

export const tavily = {
  id: 'tavily',
  label: 'Tavily',
  keyEnv: 'TAVILY_API_KEY',
  maxCalls: 12,
  maxUsd: 1,
  timeoutMs: 60_000,
  steps(query) {
    if (!query.webQuery) return { notSupported: 'not in the Tavily test plan' };
    return [{ method: 'POST', url: SEARCH, worstCaseUsd: WORST_USD,
      body: { query: query.webQuery, search_depth: 'basic', max_results: 10, include_answer: false } }];
  },
  authorize(spec, key) {
    return { url: spec.url, init: { method: spec.method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) } };
  },
  isFailure: json => !Array.isArray(json?.results),
  failureReason: json => text(json, ['detail.error', 'error', 'detail']) ?? 'VENDOR_ERROR',
  reportedCostUsd: () => null,
  reportedRaw: json => (json?.usage?.credits === undefined ? null : `${json.usage.credits} credits`),
  kind: () => 'web',
  normalize: json => list(json, ['results']).map(item => ({
    url: text(item, ['url']),
    title: text(item, ['title']),
    snippet: text(item, ['content']),
    publishedAt: timestamp(item, ['published_date', 'publishedDate']),
  })),
};
