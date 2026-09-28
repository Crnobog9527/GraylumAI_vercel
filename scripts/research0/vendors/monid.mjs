// monid (https://monid.ai/docs). A tool marketplace reselling TikHub, Apify,
// TinyFish and others. Prices come from the catalogue phase (monidCatalog.mjs,
// 2026-09-28): TikHub tools cost 1.5x TikHub's list price, TinyFish search 0.
// Runs go through POST /v1/run with a flat `input`. Responses carry `billing`
// costs in micro-dollars, but the docs do not say which of the three fields is
// the charge, so the largest is booked. Wallet balance reads (measured free in
// the catalogue phase, undocumented) bracket the run.
// The Owner approved these comparison runs in the executor window on
// 2026-09-28 ("同意 monid 正式查询"), after the catalogue phase priced them.

import { count, list, text, timestamp } from '../metrics.mjs';
import { TIKHUB_PATHS } from './tikhub.mjs';
import { normalizeTikhub } from './tikhubShapes.mjs';

const BASE = 'https://api.monid.ai/v1';
const MARGIN = 3;
// monid catalogue prices (USD per call). Q02/Q03/Q10 follow the 1.5x TikHub
// pattern seen for listed siblings; Q01 is TinyFish search, listed at 0.
const LISTED = { Q02: 0.015, Q03: 0.015, Q04: 0.0015, Q05: 0.0015, Q06: 0.0015, Q07: 0.0015, Q08: 0.0015,
  Q09: 0.0015, Q10: 0.003 };
const WEB_WORST_USD = 0.01;

function run(provider, endpoint, input, worstCaseUsd) {
  return { method: 'POST', url: `${BASE}/run`, body: { provider, endpoint, input }, worstCaseUsd };
}

function costs(json) {
  const billing = json?.billing ?? {};
  return ['calculatedCost', 'actualCost', 'reportedCost']
    .map(name => billing[name])
    .filter(cost => cost?.unit === 'MICRO_DOLLAR' && cost?.currency === 'USD' && Number.isFinite(cost?.value));
}

export const monid = {
  id: 'monid',
  label: 'monid',
  keyEnv: 'MONID_API_KEY',
  // Six ledger entries belong to the catalogue phase; 10 runs and 2 balance reads follow.
  maxCalls: 18,
  maxUsd: 1,
  timeoutMs: 90_000,
  steps(query) {
    // The docs describe a flat input, but the TinyFish tool rejects it and wants queryParams (400 on 2026-09-28).
    if (query.id === 'Q01') return [run('tinyfish', '/search', { queryParams: { query: query.webQuery, language: 'zh' } }, WEB_WORST_USD)];
    const [, pathname, params] = TIKHUB_PATHS[query.id];
    return [run('tikhub', `/api/v1${pathname}`, params, LISTED[query.id] * MARGIN)];
  },
  balance: {
    spec: () => ({ method: 'GET', url: `${BASE}/wallet/balance`, worstCaseUsd: 0.01 }),
    read: json => (json?.balance?.currency === 'USD' ? count(json, ['balance.value']) ?? null : null),
  },
  authorize(spec, key) {
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (spec.body === undefined) return { url: spec.url, init: { method: spec.method, headers } };
    return { url: spec.url, init: { method: spec.method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) } };
  },
  // A 202 (accepted async run) has no COMPLETED status: it is not polled and stays booked at worst case.
  isFailure(json, query) {
    if (json?.status !== 'COMPLETED') return true;
    const providerStatus = count(json, ['providerResponse.httpStatus']);
    if (providerStatus !== undefined && providerStatus !== 200) return true;
    // TikHub tools hand back TikHub's `data` payload itself (no {code} envelope); success is the provider status.
    if (query?.platform === 'web') return !Array.isArray(json?.output?.results);
    return providerStatus !== 200 || json?.output === undefined || json?.output === null;
  },
  failureReason: json => text(json, ['status', 'error.code', 'code']) ?? 'VENDOR_ERROR',
  // GET /v1/runs/:id returns the actual charge as cost {value USD}; sync runs carry billing in micro-dollars.
  reportedCostUsd(json) {
    if (json?.cost?.currency === 'USD' && Number.isFinite(json.cost.value)) return json.cost.value;
    const found = costs(json);
    return found.length === 0 ? null : Math.max(...found.map(cost => cost.value)) / 1e6;
  },
  reportedRaw(json) {
    if (json?.cost?.currency === 'USD' && Number.isFinite(json.cost.value)) return `cost ${json.cost.value} USD`;
    const found = costs(json);
    return found.length === 0 ? null : `billing micro-USD ${found.map(cost => cost.value).join('/')}`;
  },
  kind: query => (query.platform === 'web' ? 'web' : query.type),
  normalize(json, query) {
    if (query.platform !== 'web') return normalizeTikhub({ data: json?.output }, query);
    return list(json, ['output.results']).map(item => ({
      url: text(item, ['url']),
      title: text(item, ['title']),
      snippet: text(item, ['snippet']),
      publishedAt: timestamp(item, ['date']),
    }));
  },
};
