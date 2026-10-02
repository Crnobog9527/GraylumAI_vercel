/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readReasoningConfig } from './modelReasoning';
import { readPricingSnapshot } from './modelPricing';
import { deriveFrozenPrices } from './modelPriceBound';

export type ModelPriceRow = { model_id: string; config?: unknown };

/** Read-only report data, in USD per million tokens (request/search prices per request).
 * Never substitutes legacy prices or zero for missing supplier data. */
export function modelPriceView(row: ModelPriceRow) {
  const snapshot = readPricingSnapshot(row.config);
  const reasoning = readReasoningConfig(row.config);
  const route = reasoning.route;
  const catalog = reasoning.catalog;
  const endpoint = snapshot?.endpoints.find(item => item.tag === route);
  const catalogRoutes = catalog?.endpoints.filter(item => item.tag === route) ?? [];
  const matching = snapshot?.model === row.model_id && catalog?.model === row.model_id;
  const contextTokens = endpoint?.contextLength;
  const derived = matching && endpoint && catalogRoutes.length && contextTokens
    ? deriveFrozenPrices(row.model_id, endpoint, contextTokens) : null;
  const status = !snapshot ? 'unread' : !matching ? 'model_mismatch' : !endpoint || !catalogRoutes.length
    ? 'route_unavailable' : typeof derived === 'string' ? derived : !derived ? 'capacity_unknown' : 'ready';
  return {
    status, label: status === 'unread' ? '未读取' : status === 'ready' ? '已读取' : '不可推导',
    route, fetchedAt: snapshot?.fetchedAt ?? null, pricingHash: snapshot?.pricingHash ?? null,
    source: snapshot?.source ?? null,
    base: matching && endpoint && catalogRoutes.length ? endpoint.base : null,
    frozen: derived && typeof derived !== 'string' ? derived : null,
    promptTokensUpper: contextTokens ?? null,
  };
}
export type ModelPriceView = ReturnType<typeof modelPriceView>;
