/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** REVIEW-COACH RC-2: the few numbers every coach module shares. Numbers are code; the model only judges them. */
import type { Fact } from './rows';

export const DAY_MS = 86_400_000;
/** Bytes of the review pack tool result (the model reads this, plus the Skill). */
export const REVIEW_PACK_RESERVE = 16_000;
/** Long-run windows, in weeks. */
export const SCORE_WEEKS = 8;
export const MONTHLY_SCORE_WEEKS = 12;
/** Ledger thresholds (tech plan v1 section 5). */
export const DEFAULT_TARGET_MULT = 1.3;
export const FAILED_AT_OR_BELOW = 0.8;
export const MIN_SAMPLES = 3;
export const LOW_VOLUME_PER_WEEK = 3;
export const SHIFT_RATIO = 0.3;

/**
 * Owner decisions A-E (2026-10-27, recorded in #1482). Only B touches this module; A, C, D and E belong to the screenshot
 * reader and billing (RC-2b, RC-3).
 */
export const COACH_PENDING = {
  /** B: when basics fail, still at most 2 experiments, basics practice only, recorded in the ledger. */
  basicsFailExperiments: 2,
};

export const round = (value: number, digits = 3) => Number(value.toFixed(digits));
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = values.toSorted((x, y) => x - y), mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}
export const utcDay = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY_MS);
export const isoDay = (dayNumber: number) => new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);

/** (likes + comments + shares) / views, only when all four are real numbers and views > 0. */
export function engagementRate(values: Record<string, number> | null): number | null {
  if (!values) return null;
  const { views, likes, comments, shares } = values;
  if (views === undefined || !(views > 0) || likes === undefined || comments === undefined || shares === undefined) return null;
  return (likes + comments + shares) / views;
}

/** A day-7 metric of a settled post; engagement_rate is derived. Missing is null, never zero. */
export function day7Metric(fact: Fact, metric: string): number | null {
  if (!fact.day7) return null;
  if (metric === 'engagement_rate') return engagementRate(fact.day7);
  const value = fact.day7[metric];
  return value === undefined || fact.missing.includes(metric) ? null : value;
}
