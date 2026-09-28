// TinyFish (https://docs.tinyfish.ai). Only the Search API is used: the docs
// state it never draws from the wallet. The Agent API bills per step and its
// step cap is "beta-gated", so its worst case cannot be bounded and it is not
// called. Fetch is not used on social platforms (login walls / bot checks).

import { list, text, timestamp } from '../metrics.mjs';

const SEARCH = 'https://api.search.tinyfish.ai/';

export const tinyfish = {
  id: 'tinyfish',
  label: 'TinyFish',
  keyEnv: 'TINYFISH_API_KEY',
  maxCalls: 12,
  maxUsd: 1,
  timeoutMs: 30_000,
  steps(query) {
    if (!query.webQuery) return { notSupported: 'not in the TinyFish test plan' };
    const url = new URL(SEARCH);
    url.searchParams.set('query', query.webQuery);
    if (query.region === 'cn') url.searchParams.set('language', 'zh');
    return [{ method: 'GET', url: url.toString(), worstCaseUsd: 0, documentedFree: true }];
  },
  authorize(spec, key) {
    return { url: spec.url, init: { method: spec.method, headers: { 'X-API-Key': key, Accept: 'application/json' } } };
  },
  isFailure: json => !Array.isArray(json?.results),
  failureReason: json => text(json, ['error.code', 'error', 'code', 'message']) ?? 'NO_RESULTS_ARRAY',
  // Search responses carry no cost field (the endpoint is documented as free), so nothing is "reported".
  reportedCostUsd: () => null,
  kind: () => 'web',
  normalize: json => list(json, ['results']).map(item => ({
    url: text(item, ['url']),
    title: text(item, ['title']),
    snippet: text(item, ['snippet']),
    publishedAt: timestamp(item, ['date']),
  })),
};
