/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { axisTick, trendKpis, weekTicks, type SummaryWeek } from './trend-summary';

const week = (end: string, over: Partial<SummaryWeek> = {}): SummaryWeek => ({ end, posts: 4, viewsMedian: 1000,
  engagementMedian: 0.04, followers: 1200, ...over });
const byKey = (weeks: SummaryWeek[], gaps = {}) => Object.fromEntries(trendKpis(weeks, gaps).map(kpi => [kpi.key, kpi]));

describe('trend headline numbers', () => {
  it('shows the latest week and its change against the week right before it', () => {
    const kpis = byKey([week('2026-10-27'), week('2026-11-03', { followers: 1232, viewsMedian: 820, posts: 5, engagementMedian: 0.043 })]);
    expect(kpis.followers).toMatchObject({ value: '1,232', weekEnd: '2026-11-03', delta: { direction: 'up', text: '32' } });
    expect(kpis.views).toMatchObject({ value: '820', delta: { direction: 'down', text: '180' } });
    expect(kpis.posts).toMatchObject({ value: '5 条', delta: { direction: 'up', text: '1 条' } });
    // A rate moves in percentage points, never in percent of a percent.
    expect(kpis.engagement).toMatchObject({ value: '4.3%', delta: { direction: 'up', text: '0.3 个百分点' } });
  });

  it('uses the last week that has a value, and says which week it is (a too-new week has no views yet)', () => {
    const kpis = byKey([week('2026-10-20'), week('2026-10-27', { viewsMedian: 1100 }),
      week('2026-11-03', { viewsMedian: null, engagementMedian: null })]);
    expect(kpis.views).toMatchObject({ value: '1,100', weekEnd: '2026-10-27', delta: { direction: 'up', text: '100' } });
    expect(kpis.followers.weekEnd).toBe('2026-11-03');
  });

  it('never compares across a missing week and never turns a missing value into 0', () => {
    const kpis = byKey([week('2026-10-20'), week('2026-10-27', { followers: null }), week('2026-11-03', { followers: 1300 })]);
    expect(kpis.followers).toMatchObject({ value: '1,300', delta: null });
    const none = byKey([week('2026-11-03', { followers: null, posts: null })]);
    expect(none.followers).toMatchObject({ value: null, delta: null, gap: null });
    expect(none.posts.value).toBeNull();
    // A real 0 is a number, not a gap.
    expect(byKey([week('2026-10-27'), week('2026-11-03', { posts: 0 })]).posts).toMatchObject({ value: '0 条',
      delta: { direction: 'down', text: '4 条' } });
  });

  it('says 持平 when the change cannot be seen at the precision shown', () => {
    const kpis = byKey([week('2026-10-27'), week('2026-11-03', { engagementMedian: 0.04001 })]);
    expect(kpis.engagement.delta).toEqual({ direction: 'same', text: '持平' });
    expect(kpis.followers.delta).toEqual({ direction: 'same', text: '持平' });
  });

  it('a metric the platform does not give has no number, whatever the weeks hold', () => {
    const kpis = byKey([week('2026-11-03')], { followers: 'not_provided', engagement: 'accumulating' });
    expect(kpis.followers).toMatchObject({ value: null, gap: 'not_provided' });
    expect(kpis.engagement).toMatchObject({ value: null, gap: 'accumulating' });
    expect(kpis.views.value).toBe('1,000');
  });
});

describe('axis ticks', () => {
  it('keeps every digit of a four-digit number and shortens only large ones', () => {
    // 2026-11-11: "1,400" was drawn as "400" because the axis had a negative margin.
    expect(axisTick(1400)).toBe('1,400');
    expect(axisTick(0)).toBe('0');
    expect(axisTick(4.25)).toBe('4.25');
    expect(axisTick(12500)).toBe('1.3万');
    expect(axisTick(120000)).toBe('12万');
    expect(axisTick(230000000)).toBe('2.3亿');
  });

  it('dates at most six weeks, evenly, always including the latest one', () => {
    const labels = Array.from({ length: 13 }, (_, index) => `w${index}`);
    expect(weekTicks(labels)).toEqual(['w0', 'w3', 'w6', 'w9', 'w12']);
    expect(weekTicks(labels.slice(0, 12))).toEqual(['w1', 'w3', 'w5', 'w7', 'w9', 'w11']);
    expect(weekTicks(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(weekTicks([])).toEqual([]);
  });
});
