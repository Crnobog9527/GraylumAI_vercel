/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readReasoningConfig } from './modelReasoning';

type CapacityRow = { model_id: string; input_limit?: number | null; max_tokens: number | null; config: unknown };

/** Duplicate route tags use their smallest known capacity; any missing value stays unknown. */
export function modelCapacityView(row: CapacityRow) {
  const reasoning = readReasoningConfig(row.config);
  const catalog = reasoning.catalog;
  const routes = catalog?.model === row.model_id
    ? catalog.endpoints.filter(endpoint => endpoint.tag === reasoning.route) : [];
  const minimum = (key: 'contextLength' | 'maxCompletionTokens') =>
    routes.length && routes.every(route => route[key] !== null) ? Math.min(...routes.map(route => route[key]!)) : null;
  const field = (supplier: number | null, current: number | null | undefined) => ({
    supplier, current: current ?? null, matches: supplier === null ? null : supplier === current,
  });
  return {
    route: reasoning.route, fetchedAt: catalog?.model === row.model_id ? catalog.fetchedAt : null,
    inputLimit: field(minimum('contextLength'), row.input_limit),
    maxTokens: field(minimum('maxCompletionTokens'), row.max_tokens),
  };
}

/** Called only by an explicit administrator catalog refresh, never by automatic price renewal or route saves. */
export function supplierCapacityPatch(row: CapacityRow) {
  const capacity = modelCapacityView(row);
  return {
    ...(capacity.inputLimit.supplier !== null ? { input_limit: capacity.inputLimit.supplier } : {}),
    ...(capacity.maxTokens.supplier !== null ? { max_tokens: capacity.maxTokens.supplier } : {}),
  };
}
