import { divRoundPico, picoToUsd, sumUsdPico, usdToPico } from './reportUsd';

interface RecordedCostRow {
  total_cost_usd: string | number | null;
}

interface CacheCostRow {
  model_used: string | null;
  cached_tokens: number | null;
}

interface CurrentModelPrice {
  model_id: string;
  input_token_cost: number | null;
}

export function estimateCacheSavings(rows: CacheCostRow[], models: CurrentModelPrice[]): number | null {
  const prices = new Map(models.map((model) => [model.model_id, model.input_token_cost]));
  let estimatePico = 0n;
  for (const row of rows) {
    if (row.cached_tokens === null) return null;
    if (row.cached_tokens === 0) continue;
    const price = prices.get(row.model_used ?? '');
    if (price === undefined || price === null || price <= 0) return null;
    // cached_tokens * price * 0.9 / 1e12 USD, which is cached_tokens * price * 0.9 picodollars.
    estimatePico += divRoundPico(BigInt(row.cached_tokens) * usdToPico(price) * 9n, 10n ** 13n);
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
