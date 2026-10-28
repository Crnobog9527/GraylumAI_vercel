/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Sql } from 'postgres';

import { TEST_MODEL_ID } from './config';

export interface CompareModel {
  id: string;
  modelId: string;
  name: string;
  /** Per million tokens, the cheapest admissible OpenRouter line: prompt + completion. */
  usdPerMillion: number;
}

interface PricedEndpoint { admissible?: boolean; base?: { prompt?: string | number; completion?: string | number } }

/** The cheapest admissible line of a model's synced price snapshot (ai_models.config.pricing), or null when there is none. */
export function cheapestLine(config: unknown): number | null {
  const endpoints = ((config as { pricing?: { endpoints?: PricedEndpoint[] } } | null)?.pricing?.endpoints) ?? [];
  const sums = endpoints.filter(endpoint => endpoint.admissible !== false).map(endpoint =>
    Number(endpoint.base?.prompt) + Number(endpoint.base?.completion)).filter(Number.isFinite);
  return sums.length ? Math.min(...sums) : null;
}

/** Journey 5 compares Haiku with the cheapest other model on the compare list (Owner/controller 2026-10-28). */
export function cheapestOther(models: readonly CompareModel[], excludeModelId = TEST_MODEL_ID): CompareModel | null {
  const others = models.filter(model => model.modelId !== excludeModelId);
  return others.length ? others.reduce((best, model) => (model.usdPerMillion < best.usdPerMillion ? model : best)) : null;
}

/**
 * The models the compare picker offers, looked up by the names it shows. The read-only evidence role cannot read
 * system settings, so the list comes from the page itself and only the (non-secret) synced prices come from ai_models.
 */
export async function readModelsByName(sql: Sql, names: readonly string[]): Promise<CompareModel[]> {
  if (names.length === 0) return [];
  const rows = await sql<Array<{ id: string; model_id: string; name: string; config: unknown }>>`
    select id, model_id, name, config from ai_models where is_active = 'true' and name = any(${names as string[]})`;
  return rows.flatMap(row => {
    const price = cheapestLine(row.config);
    return price === null ? [] : [{ id: row.id, modelId: row.model_id, name: row.name, usdPerMillion: price }];
  });
}
