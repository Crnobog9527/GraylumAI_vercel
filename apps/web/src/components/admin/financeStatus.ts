/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

export type ActiveFlag = string | boolean;
export type ActiveState = 'on' | 'off' | 'unknown';

/** Only 'true'/'false' (or the booleans) are known; anything else is shown as-is, never guessed. */
export function activeState(value: ActiveFlag): ActiveState {
  if (value === true || value === 'true') return 'on';
  if (value === false || value === 'false') return 'off';
  return 'unknown';
}

export function activeLabel(value: ActiveFlag, labels: { on: string; off: string }) {
  const state = activeState(value);
  if (state === 'unknown') return `${String(value)}（未知状态）`;
  return labels[state];
}

export interface FinanceUnknownInput {
  transactions?: { unknownTypeCount?: number; unknownTypes?: Record<string, number> };
  packages?: { unknownActiveCount?: number; packages: { active: ActiveFlag }[] };
  runtimeBilling?: { unknownModelActiveCount?: number };
  modelStats?: { isActive: ActiveFlag }[];
}

export interface FinanceUnknownItem {
  key: 'transactionType' | 'packageStatus' | 'modelStatus';
  title: string;
  count: number;
  /** Raw values with how many rows carry each one. */
  values: { value: string; count: number }[];
}

function countUnknownFlags(flags: ActiveFlag[]) {
  const counts = new Map<string, number>();
  flags.filter((flag) => activeState(flag) === 'unknown')
    .forEach((flag) => counts.set(String(flag), (counts.get(String(flag)) ?? 0) + 1));
  return [...counts].map(([value, count]) => ({ value, count }));
}

/** Unrecognized ledger types and status values the finance report could not classify. */
export function collectFinanceUnknowns(data: FinanceUnknownInput | undefined): FinanceUnknownItem[] {
  if (!data) return [];
  const items: FinanceUnknownItem[] = [];
  const typeCount = data.transactions?.unknownTypeCount ?? 0;
  if (typeCount > 0) {
    const values = Object.entries(data.transactions?.unknownTypes ?? {}).map(([value, count]) => ({ value, count }));
    items.push({ key: 'transactionType', title: '未知流水类型（未计入收支）', count: typeCount, values });
  }
  const packageCount = data.packages?.unknownActiveCount ?? 0;
  if (packageCount > 0) {
    const values = countUnknownFlags((data.packages?.packages ?? []).map((pkg) => pkg.active));
    items.push({ key: 'packageStatus', title: '未知积分包状态', count: packageCount, values });
  }
  const modelCount = data.runtimeBilling?.unknownModelActiveCount ?? 0;
  if (modelCount > 0) {
    const values = countUnknownFlags((data.modelStats ?? []).map((model) => model.isActive));
    items.push({ key: 'modelStatus', title: '未知模型状态（不计入活跃模型）', count: modelCount, values });
  }
  return items;
}
