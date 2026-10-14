/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The benchmark table (RESEARCH_TOOLS_PLAN.md §1.4): one row per account, numbers computed by code from fetched
// evidence (RT-4a `accountMetrics`), each with the evidence refs it came from. A missing number stays missing and
// is shown as such, never as 0.
import type { BenchmarkCategory } from "../../../../../packages/api/src/services/research/benchmark/classify";
import type { AccountMetrics } from "../../../../../packages/api/src/services/research/benchmark/metrics";
import type { SocialPlatform } from "../../../../../packages/api/src/services/research/vendors/types";
import { MISSING_TEXT, platformLabel } from "./research-model";

export interface BenchmarkRow {
  platform: SocialPlatform;
  account: string;
  category: BenchmarkCategory | null;
  qualified: boolean;
  metrics: Pick<AccountMetrics, "followers" | "medianViews" | "engagementRate" | "postsPerWeek" | "lastPublishedAt">;
}

export const CATEGORY_LABELS: Record<BenchmarkCategory, string> = {
  head_reference: "头部参考", imitable: "同量级可模仿", fast_rising: "近期起号快",
};

export const COLUMNS = [
  { key: "followers", label: "粉丝" },
  { key: "medianViews", label: "播放中位数" },
  { key: "engagementRate", label: "互动率" },
  { key: "postsPerWeek", label: "更新频率" },
  { key: "lastPublishedAt", label: "最近更新" },
] as const;
export type ColumnKey = typeof COLUMNS[number]["key"];

const valid = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const trim = (value: number, digits: number) => value.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, "$1");

/** Chinese count units: 9,800 · 1.2 万 · 3.4 亿. */
export function formatCount(value: number | null): string {
  if (!valid(value)) return MISSING_TEXT;
  if (value >= 1e8) return `${trim(value / 1e8, 1)} 亿`;
  if (value >= 1e4) return `${trim(value / 1e4, 1)} 万`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatRate(value: number | null): string {
  return valid(value) ? `${trim(value * 100, value * 100 >= 10 ? 1 : 2)}%` : MISSING_TEXT;
}

export function formatFrequency(value: number | null): string {
  return valid(value) ? `每周 ${trim(value, 1)} 条` : MISSING_TEXT;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Calendar date plus how long ago, e.g. "2026-10-12（3 天前）". */
export function formatLastUpdate(value: string | null, now: Date): string {
  const ms = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(ms)) return MISSING_TEXT;
  const date = new Date(ms).toISOString().slice(0, 10);
  const days = Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
  return `${date}（${days === 0 ? "今天" : `${days} 天前`}）`;
}

export function cellText(row: BenchmarkRow, key: ColumnKey, now: Date): string {
  const { metrics } = row;
  switch (key) {
    case "followers": return formatCount(metrics.followers.value);
    case "medianViews": return formatCount(metrics.medianViews.value);
    case "engagementRate": return formatRate(metrics.engagementRate.value);
    case "postsPerWeek": return formatFrequency(metrics.postsPerWeek.value);
    case "lastPublishedAt": return formatLastUpdate(metrics.lastPublishedAt.value, now);
  }
}

/** A cell with a value carries its refs; a missing one carries none. */
export function cellRefs(row: BenchmarkRow, key: ColumnKey): string[] {
  const metric = row.metrics[key];
  return metric.value === null ? [] : metric.refs;
}

/** The evidence record a ref points into: "e1#3" → "e1". */
export const evidenceOf = (ref: string): string => ref.split("#")[0] ?? ref;

export interface SourceEntry { number: number; evidenceId: string; account: string }

/**
 * Numbers every evidence record the table cites, in reading order (row by row, column by column), so each cell
 * can show "[1]" and the footer can say what [1] is.
 */
export function numberSources(rows: BenchmarkRow[]): { entries: SourceEntry[]; numberOf: (ref: string) => number | undefined } {
  const numbers = new Map<string, number>();
  const entries: SourceEntry[] = [];
  for (const row of rows) {
    for (const column of COLUMNS) {
      for (const ref of cellRefs(row, column.key)) {
        const evidenceId = evidenceOf(ref);
        if (numbers.has(evidenceId)) continue;
        numbers.set(evidenceId, entries.length + 1);
        entries.push({ number: entries.length + 1, evidenceId, account: `${platformLabel(row.platform)} ${row.account}` });
      }
    }
  }
  return { entries, numberOf: ref => numbers.get(evidenceOf(ref)) };
}

/** Distinct source numbers of one cell, ascending. */
export function cellSourceNumbers(row: BenchmarkRow, key: ColumnKey, numberOf: (ref: string) => number | undefined): number[] {
  const found = cellRefs(row, key).map(numberOf).filter((n): n is number => n !== undefined);
  return [...new Set(found)].sort((a, b) => a - b);
}
