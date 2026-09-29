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
  let estimate = 0;
  for (const row of rows) {
    if (row.cached_tokens === null) return null;
    if (row.cached_tokens === 0) continue;
    const price = prices.get(row.model_used ?? '');
    if (price === undefined || price === null || price <= 0) return null;
    estimate += row.cached_tokens * price * 0.9 / 1_000_000_000_000;
  }
  return estimate;
}

export function buildPerformanceCostStats(
  rows: RecordedCostRow[],
  days: number,
  estimatedCacheSavings: number | null,
) {
  const totalCost = rows.reduce((sum, row) => sum + Number(row.total_cost_usd ?? 0), 0);
  return {
    totalCost,
    avgCostPerRequest: rows.length ? totalCost / rows.length : 0,
    cacheSavings: estimatedCacheSavings,
    estimatedMonthly: totalCost * (30 / days),
  };
}
