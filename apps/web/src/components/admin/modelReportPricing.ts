/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';

type ReasoningView = inferRouterOutputs<AppRouter>['modelReasoning']['get'];
/** Server projections (packages/api/src/shared/modelPriceView.ts, modelCapacityView.ts). */
export type ModelPriceView = ReasoningView['priceView'];
export type ModelCapacityView = ReasoningView['capacity'];

const TOKEN_UNIT = '美元 / 百万 token';
const REQUEST_UNIT = '美元 / 次';

/** Why a price projection cannot be used; keys are the server's `pricing.status` values. */
const STATUS_REASONS: Record<string, string> = {
  model_mismatch: '价格属于别的模型 ID，请重新读取',
  route_unavailable: '已选线路不在最新价格或目录里',
  capacity_unknown: '供应商没有给出这条线路的上下文长度',
  NOT_ADMISSIBLE: '这条线路的价格不能用于计费',
  UNKNOWN_PRICE_FIELD: '价格里有本系统不认识的字段',
};

export function priceStatusReason(status: string): string {
  return STATUS_REASONS[status] ?? '价格不可用';
}

export type PriceCellKind = 'prompt' | 'completion' | 'web_search';
export type PriceCell = { main: string; details: string[]; known: boolean };

/**
 * Report cell text for one price of the read-only projection. Missing data is
 * spelled out ("未读取", "不可推导"); it never falls back to zero or legacy prices.
 */
export function priceCell(pricing: ModelPriceView, kind: PriceCellKind): PriceCell {
  if (pricing.status === 'unread') return { main: '未读取', details: [], known: false };
  if (!pricing.base) return { main: pricing.label, details: [priceStatusReason(pricing.status)], known: false };
  if (kind === 'web_search') {
    const search = pricing.base.web_search;
    return search === undefined
      ? { main: '目录未列出', details: [], known: false }
      : { main: `$${search}`, details: [REQUEST_UNIT], known: true };
  }
  const base = pricing.base[kind];
  const frozen = pricing.frozen
    ? kind === 'prompt' ? pricing.frozen.promptUsdPerMillion : pricing.frozen.completionUsdPerMillion
    : null;
  const details = [TOKEN_UNIT];
  details.push(frozen === null ? `冻结用单价：不可推导（${priceStatusReason(pricing.status)}）` : `冻结用单价 $${frozen}`);
  return { main: base === undefined ? '目录未列出' : `$${base}`, details, known: base !== undefined };
}

/**
 * Reference user price in credits: unit price (USD) × multiplier m × credits per USD q.
 * Null when any factor is unknown; never guessed.
 */
export function userPricePreview(usd: string, multiplier: string | null, creditsPerUsd: string | null): string | null {
  if (multiplier === null || creditsPerUsd === null) return null;
  const value = Number(usd) * Number(multiplier) * Number(creditsPerUsd);
  if (!Number.isFinite(value)) return null;
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export type CapacityField = 'inputLimit' | 'maxTokens';
export const CAPACITY_LABELS: Record<CapacityField, string> = { inputLimit: '上下文限制', maxTokens: '最大输出 Token' };

const count = (value: number | null) => (value === null ? null : value.toLocaleString('en-US'));

export type CapacityRow = {
  field: CapacityField;
  label: string;
  supplier: string;
  current: string;
  state: string;
  mismatch: boolean;
};

/** One display row per capacity value: supplier value, stored value and whether they agree. */
export function capacityRows(capacity: ModelCapacityView): CapacityRow[] {
  return (['inputLimit', 'maxTokens'] as const).map(field => {
    const value = capacity[field];
    return {
      field,
      label: CAPACITY_LABELS[field],
      supplier: count(value.supplier) ?? '未知',
      current: count(value.current) ?? '未设置',
      state: value.matches === null ? '无法比较' : value.matches ? '一致' : '不一致',
      mismatch: value.matches === false,
    };
  });
}

/** What the last explicit read changed: "旧值 → 新值" per field that moved. */
export function capacitySyncChanges(previous: ModelCapacityView, now: ModelCapacityView): string[] {
  return (['inputLimit', 'maxTokens'] as const).flatMap(field => {
    const before = previous[field].current, after = now[field].current;
    if (before === after) return [];
    return [`${CAPACITY_LABELS[field]}：${count(before) ?? '未设置'} → ${count(after) ?? '未设置'}`];
  });
}
