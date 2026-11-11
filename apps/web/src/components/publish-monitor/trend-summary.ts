/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { formatMetric } from './labels';

/**
 * The headline numbers above the trend charts: for each of the four weekly metrics, the latest week that has a value
 * and how it moved against the week right before it. Everything is read from the weeks the trend query already
 * returns; nothing is estimated. A week without a value is never treated as 0, and a change is only shown when the
 * week right before also has a value.
 */
export type SummaryWeek = { end: string; posts: number | null; viewsMedian: number | null; engagementMedian: number | null;
  followers: number | null };
export type SummaryGap = 'not_provided' | 'accumulating';
export type SummaryGaps = Partial<Record<'followers' | 'views' | 'engagement', SummaryGap>>;
export type Delta = { direction: 'up' | 'down' | 'same'; text: string };
export type Kpi = { key: 'followers' | 'views' | 'engagement' | 'posts'; label: string; value: string | null;
  weekEnd: string | null; delta: Delta | null; gap: SummaryGap | null };

type Metric = { key: Kpi['key']; label: string; read: (week: SummaryWeek) => number | null;
  format: (value: number) => string; change: (now: number, before: number) => { amount: number; text: string } };

const plain = (value: number) => formatMetric('views', value);
/** Rounded to the two decimals the page shows, so a change that cannot be seen is "持平", not "↑ 0". */
const round2 = (value: number) => Math.round(value * 100) / 100;
const counted = (unit: string) => (now: number, before: number) => {
  const amount = round2(now - before);
  return { amount, text: `${plain(Math.abs(amount))}${unit}` };
};

const METRICS: Metric[] = [
  { key: 'followers', label: '粉丝', read: w => w.followers, format: plain, change: counted('') },
  { key: 'views', label: '每条播放/浏览中位数', read: w => w.viewsMedian, format: plain, change: counted('') },
  { key: 'engagement', label: '互动率中位数', read: w => w.engagementMedian,
    format: value => formatMetric('engagement_rate', value),
    // A rate moves in percentage points: 4.2% to 4.5% is 0.3 points, not 7%.
    change: (now, before) => {
      const amount = round2((now - before) * 100);
      return { amount, text: `${plain(Math.abs(amount))} 个百分点` };
    } },
  { key: 'posts', label: '最近一周发布', read: w => w.posts, format: value => `${plain(value)} 条`, change: counted(' 条') },
];

export function trendKpis(weeks: SummaryWeek[], gaps: SummaryGaps): Kpi[] {
  return METRICS.map(metric => {
    const gap = metric.key === 'posts' ? null : gaps[metric.key] ?? null;
    const index = gap ? -1 : weeks.findLastIndex(week => metric.read(week) !== null);
    if (index < 0) return { key: metric.key, label: metric.label, value: null, weekEnd: null, delta: null, gap };
    const now = metric.read(weeks[index]!)!;
    const before = index > 0 ? metric.read(weeks[index - 1]!) : null;
    let delta: Delta | null = null;
    if (before !== null) {
      const { amount, text } = metric.change(now, before);
      delta = amount === 0 ? { direction: 'same', text: '持平' } : { direction: amount > 0 ? 'up' : 'down', text };
    }
    return { key: metric.key, label: metric.label, value: metric.format(now), weekEnd: weeks[index]!.end, delta, gap: null };
  });
}

/**
 * Which weeks get a date under the axis: at most six, evenly spaced and counted back from the latest week, so the
 * newest date is always there and the labels never crowd on a 360px screen.
 */
export function weekTicks(labels: string[]): string[] {
  const step = Math.max(1, Math.ceil(labels.length / 6));
  return labels.filter((_, index) => (labels.length - 1 - index) % step === 0);
}

/** Axis ticks stay short enough for the 44px axis on a 360px screen: 12,000 is "1.2万", 1,400 stays "1,400". */
export function axisTick(value: number): string {
  if (!Number.isFinite(value)) return '';
  const size = Math.abs(value);
  if (size >= 100_000_000) return `${round2(value / 100_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}亿`;
  if (size >= 10_000) return `${(value / 10_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
