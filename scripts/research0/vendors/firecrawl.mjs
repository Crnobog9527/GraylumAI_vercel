// Firecrawl direct (https://docs.firecrawl.dev, v1 API). Owner-provided key,
// 2026-09-28; the variable arrived as firecrawl_API_KEY, accepted as an alias.
// Two searches plus three public, login-free pages. Social platforms are not
// fetched and no anti-bot option is requested.

import { count, list, text, timestamp } from '../metrics.mjs';

const BASE = 'https://api.firecrawl.dev/v1';
const WORST_USD = 0.02;
const SEARCHES = { Q01: 'zh', Q07: 'en' };

export const firecrawl = {
  id: 'firecrawl',
  label: 'Firecrawl',
  keyEnv: 'FIRECRAWL_API_KEY',
  keyEnvAliases: ['firecrawl_API_KEY'],
  maxCalls: 8,
  maxUsd: 1,
  timeoutMs: 90_000,
  steps(query) {
    if (query.type === 'fetch') {
      return [{ method: 'POST', url: `${BASE}/scrape`, worstCaseUsd: WORST_USD, body: { url: query.url, formats: ['markdown'], onlyMainContent: true } }];
    }
    if (SEARCHES[query.id]) {
      return [{ method: 'POST', url: `${BASE}/search`, worstCaseUsd: WORST_USD, body: { query: query.webQuery, limit: 10, lang: SEARCHES[query.id] } }];
    }
    return { notSupported: 'not in the Firecrawl test plan' };
  },
  authorize(spec, key) {
    return { url: spec.url, init: { method: spec.method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) } };
  },
  isFailure: json => json?.success !== true,
  failureReason: json => text(json, ['error', 'code']) ?? 'VENDOR_ERROR',
  reportedCostUsd: () => null,
  reportedRaw: json => {
    const credits = count(json, ['creditsUsed', 'data.metadata.creditsUsed']);
    return credits === undefined ? null : `${credits} credits`;
  },
  kind: query => (query.type === 'fetch' ? 'fetch' : 'web'),
  normalize(json, query) {
    if (query.type !== 'fetch') {
      return list(json, ['data', 'data.web']).map(item => ({
        url: text(item, ['url']),
        title: text(item, ['title', 'metadata.title']),
        snippet: text(item, ['description', 'snippet']),
        publishedAt: timestamp(item, ['publishedDate', 'metadata.publishedTime', 'date']),
      }));
    }
    const markdown = text(json, ['data.markdown']);
    return [{
      url: text(json, ['data.metadata.sourceURL', 'data.metadata.url']),
      title: text(json, ['data.metadata.title', 'data.metadata.ogTitle']),
      publishedAt: timestamp(json, ['data.metadata.publishedTime', 'data.metadata.article:published_time', 'data.metadata.modifiedTime']),
      language: text(json, ['data.metadata.language']),
      contentChars: markdown === undefined ? undefined : markdown.length,
    }];
  },
};
