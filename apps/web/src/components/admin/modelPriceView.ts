/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  PRICE_KEYS, PRICE_LABELS, PRICING_ISSUES, describeCondition, priceUnit,
  type PriceChange, type PriceLayer, type PricedEndpoint, type PricingSnapshot,
} from '@repo/api/src/shared/modelPricing';

/** Plan D1 (Owner, 2026-10-02): a price snapshot older than this is stale. */
export const PRICE_SNAPSHOT_STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PriceRow = { key: string; label: string; value: string; unit: string };

/** Display rows of one price layer, in a fixed order, listing only the prices present. */
export function priceRows(layer: PriceLayer): PriceRow[] {
  return PRICE_KEYS.filter(key => layer[key] !== undefined).map(key => ({ key, label: PRICE_LABELS[key], value: layer[key]!, unit: priceUnit(key) }));
}

/** Whole days since a snapshot was read, and whether it is stale. */
export function snapshotAge(fetchedAt: string, now: number): { days: number; stale: boolean } {
  const age = Math.max(0, now - Date.parse(fetchedAt));
  return { days: Math.floor(age / DAY_MS), stale: age > PRICE_SNAPSHOT_STALE_DAYS * DAY_MS };
}

export type RouteView = {
  tag: string;
  admissible: boolean;
  problems: string[];
  base: PriceRow[];
  tiers: Array<{ condition: string; prices: PriceRow[] }>;
  discount: number | null;
  unknownKeys: string[];
  contextLength: number | null;
};

export function routeView(endpoint: PricedEndpoint): RouteView {
  return {
    tag: endpoint.tag,
    admissible: endpoint.admissible,
    problems: endpoint.issues.map(issue => PRICING_ISSUES[issue]),
    base: priceRows(endpoint.base),
    tiers: endpoint.overrides.map(item => ({ condition: describeCondition(item.when), prices: priceRows(item.prices) })),
    discount: endpoint.discount,
    unknownKeys: endpoint.unknownKeys,
    contextLength: endpoint.contextLength,
  };
}

/** The selected route of a snapshot, or why it cannot be shown. */
export function selectedRoute(pricing: PricingSnapshot | null, route: string | null, modelId: string):
  { state: 'missing' | 'model_changed' | 'no_route' | 'route_missing' } | { state: 'ok'; view: RouteView } {
  if (!pricing) return { state: 'missing' };
  if (pricing.model !== modelId) return { state: 'model_changed' };
  if (!route) return { state: 'no_route' };
  const endpoint = pricing.endpoints.find(item => item.tag === route);
  return endpoint ? { state: 'ok', view: routeView(endpoint) } : { state: 'route_missing' };
}

/** One readable line per change from the last price read. */
export function describeChange(change: PriceChange): string {
  if (change.change === 'added') return `新增线路 ${change.tag}`;
  if (change.change === 'removed') return `线路 ${change.tag} 已不在目录里`;
  const field = change.field ?? '';
  const key = field.split('.').pop() as keyof typeof PRICE_LABELS;
  const name = PRICE_LABELS[key] ? field.replace(key, PRICE_LABELS[key]) : field;
  const raised = change.before !== undefined && change.after !== undefined && /^\d/.test(change.before) && /^\d/.test(change.after)
    && Number(change.after) > Number(change.before);
  return `${change.tag} · ${name}：${change.before ?? '无'} → ${change.after ?? '无'}${raised ? '（上涨）' : ''}`;
}
