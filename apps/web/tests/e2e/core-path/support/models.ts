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

/** The models on the back-office compare list (fusion_settings.compare.allowedModelIds), with their synced prices. */
export async function readCompareModels(sql: Sql): Promise<CompareModel[]> {
  const rows = await sql<Array<{ id: string; model_id: string; name: string; config: unknown }>>`
    select m.id, m.model_id, m.name, m.config from ai_models m
    where m.is_active = 'true' and m.id::text in (
      select jsonb_array_elements_text(s.value->'compare'->'allowedModelIds') from system_settings s where s.key = 'fusion_settings')`;
  return rows.flatMap(row => {
    const price = cheapestLine(row.config);
    return price === null ? [] : [{ id: row.id, modelId: row.model_id, name: row.name, usdPerMillion: price }];
  });
}
