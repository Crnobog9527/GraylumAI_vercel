import { modelPriceView, type ModelPriceRow } from '../shared/modelPriceView';
import { divRoundPico, picoToUsd, sumUsdPico, usdToPico } from './reportUsd';

interface RecordedCostRow {
  total_cost_usd: string | number | null;
}

interface CacheCostRow {
  model_used: string | null;
  cached_tokens: number | null;
}

export function estimateCacheSavings(rows: CacheCostRow[], models: ModelPriceRow[]): number | null {
  // A token_stats model id cannot identify one route when multiple configured rows share it.
  const prices = new Map<string, ReturnType<typeof modelPriceView> | null>();
  for (const model of models) prices.set(model.model_id, prices.has(model.model_id) ? null : modelPriceView(model));
  let estimatePico = 0n;
  for (const row of rows) {
    if (row.cached_tokens === null) return null;
    if (row.cached_tokens === 0) continue;
    const price = prices.get(row.model_used ?? '');
    const input = price?.base?.prompt, cache = price?.base?.input_cache_read;
    if (!price?.frozen || input === undefined || cache === undefined) return null;
    estimatePico += divRoundPico(BigInt(row.cached_tokens) * (usdToPico(input) - usdToPico(cache)), 1_000_000n);
  }
  return picoToUsd(estimatePico);
}

export function buildPerformanceCostStats(
  rows: RecordedCostRow[],
  days: number,
  estimatedCacheSavings: number | null,
) {
  const totalPico = sumUsdPico(rows.map((row) => row.total_cost_usd));
  return {
    totalCost: picoToUsd(totalPico),
    avgCostPerRequest: rows.length ? picoToUsd(divRoundPico(totalPico, BigInt(rows.length))) : 0,
    cacheSavings: estimatedCacheSavings,
    estimatedMonthly: picoToUsd(divRoundPico(totalPico * 30n, BigInt(days))),
  };
}

interface CacheTokenRow {
  input_tokens: number | null;
  cached_tokens: number | null;
}

/**
 * Share of input tokens served from cache, in percent. Returns null (unknown) when any row
 * did not record cache usage or input usage, since either gap leaves the ratio undetermined.
 */
export function calculateTokenCacheHitRate(rows: CacheTokenRow[]): number | null {
  if (rows.some((row) => row.cached_tokens === null || row.input_tokens === null)) return null;
  const cachedTokens = rows.reduce((sum, row) => sum + (row.cached_tokens ?? 0), 0);
  const totalInputTokens = rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0) + cachedTokens;
  return totalInputTokens > 0 ? parseFloat(((cachedTokens / totalInputTokens) * 100).toFixed(1)) : 0;
}
