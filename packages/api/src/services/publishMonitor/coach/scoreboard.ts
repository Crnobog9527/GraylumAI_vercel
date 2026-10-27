/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2: long-run scorecards per content pillar and platform, against the account's own baseline, and the
 * platform-wide shift check. Only the same platform and the same basis are ever compared.
 */
import type { Fact } from './rows';
import { DAY_MS, SHIFT_RATIO, day7Metric, median, round, utcDay } from './stats';

export type ScoreRow = { pillar: string; platform: string; basis: 'day7'; weeks: number; samples: number;
  views_median: number | null; er_median: number | null; vs_platform_median: number | null };
export type HistoryRow = { pillar: string; platform: string; basis: 'cumulative_at_import'; samples: number;
  views_median: number | null };
export type Shift = { platform: string; detected: boolean; direction: 'down' | 'up' | null; pillars: number;
  ratios: Record<string, number> };

const UNTAGGED = 'untagged';
const inWindow = (fact: Fact, fromDay: number, toDay: number) => {
  const d = utcDay(fact.postedAt);
  return d >= fromDay && d < toDay;
};

/** Settled posts published in [now - weeks, now), grouped by pillar x platform; untagged posts form their own group. */
export function scoreboard(facts: Fact[], now: number, weeks: number): ScoreRow[] {
  const today = Math.floor(now / DAY_MS), from = today - weeks * 7;
  const settled = facts.filter(f => f.day7 && inWindow(f, from, today));
  const platformMedian = new Map<string, number | null>();
  for (const platform of new Set(settled.map(f => f.platform)))
    platformMedian.set(platform, median(settled.filter(f => f.platform === platform)
      .map(f => day7Metric(f, 'views')).filter((v): v is number => v !== null)));
  const groups = new Map<string, Fact[]>();
  for (const f of settled) {
    const key = `${f.pillarKey ?? UNTAGGED}\u0000${f.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups].map(([key, rows]) => {
    const [pillar, platform] = key.split('\u0000') as [string, string];
    const views = median(rows.map(f => day7Metric(f, 'views')).filter((v): v is number => v !== null));
    const er = median(rows.map(f => day7Metric(f, 'engagement_rate')).filter((v): v is number => v !== null));
    const base = platformMedian.get(platform) ?? null;
    return { pillar, platform, basis: 'day7' as const, weeks, samples: rows.length,
      views_median: views === null ? null : Math.round(views), er_median: er === null ? null : round(er, 4),
      vs_platform_median: views !== null && base ? round(views / base, 2) : null };
  }).sort((a, b) => a.platform.localeCompare(b.platform) || a.pillar.localeCompare(b.pillar));
}

/** Posts first seen after day 7 (connected later): compared only with each other, never with day-7 values. */
export function historyScoreboard(facts: Fact[]): HistoryRow[] {
  const groups = new Map<string, number[]>();
  for (const f of facts) {
    if (f.basis !== 'cumulative_at_import' || !f.importCumulative) continue;
    const views = f.importCumulative.views;
    if (views === undefined || f.missing.includes('views')) continue;
    const key = `${f.pillarKey ?? UNTAGGED}\u0000${f.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), views]);
  }
  return [...groups].map(([key, values]) => {
    const [pillar, platform] = key.split('\u0000') as [string, string];
    const views = median(values);
    return { pillar, platform, basis: 'cumulative_at_import' as const, samples: values.length,
      views_median: views === null ? null : Math.round(views) };
  }).sort((a, b) => a.platform.localeCompare(b.platform) || a.pillar.localeCompare(b.pillar));
}

/**
 * A platform-wide reach change (algorithm shift, outage of reach): at least two pillars with two or more settled posts in
 * the period, every one of them more than SHIFT_RATIO away from its own 8-week baseline before the period, same direction.
 */
export function platformShift(facts: Fact[], platform: string, periodStartDay: number, periodEndDay: number,
  exclude: ReadonlySet<string> = new Set()): Shift {
  const ratios: Record<string, number> = {};
  // An experiment's own posts carry the change under test; they cannot also define the platform's baseline move.
  const own = facts.filter(f => f.platform === platform && f.day7 && !exclude.has(f.postId));
  const pillars = new Set(own.map(f => f.pillarKey ?? UNTAGGED));
  for (const pillar of pillars) {
    const views = (from: number, to: number) => own.filter(f => (f.pillarKey ?? UNTAGGED) === pillar && inWindow(f, from, to))
      .map(f => day7Metric(f, 'views')).filter((v): v is number => v !== null);
    const current = views(periodStartDay, periodEndDay + 1), before = views(periodStartDay - 56, periodStartDay);
    const now = median(current), base = median(before);
    if (current.length >= 2 && before.length >= 2 && now !== null && base) ratios[pillar] = round(now / base, 2);
  }
  const values = Object.values(ratios);
  const down = values.length >= 2 && values.every(r => r < 1 - SHIFT_RATIO);
  const up = values.length >= 2 && values.every(r => r > 1 + SHIFT_RATIO);
  return { platform, detected: down || up, direction: down ? 'down' : up ? 'up' : null, pillars: values.length, ratios };
}
