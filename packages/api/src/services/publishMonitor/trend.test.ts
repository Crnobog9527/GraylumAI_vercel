/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { DAY_MS, isoDay } from './coach/stats';
import { readTrend, trendSeries } from './trend';

const now = Date.parse('2026-11-03T12:00:00Z');
const conn = (over: Record<string, unknown> = {}) => ({ id: '00000000-0000-4000-8000-0000000a0001', platform: 'tiktok',
  source: 'tikhub' as const, businessId: null, businessName: '家常菜', connectedAt: '2026-10-01T08:00:00Z',
  followers: [] as Array<{ date: string; value: number }>, posts: [] as Array<{ postedAt: string; day7: Record<string, number> | null }>,
  ...over });
const day7 = (views: number, extra: Record<string, number> = { likes: 10, comments: 5, shares: 5 }) => ({ views, ...extra });

describe('trendSeries', () => {
  it('buckets by the 7-day weeks ending yesterday, medians the day-7 numbers and keeps the last follower point', () => {
    const [s] = trendSeries({ windowDays: 30, connections: [conn({
      followers: [{ date: '2026-10-20', value: 100 }, { date: '2026-10-23', value: 120 }, { date: '2026-10-30', value: 150 }],
      posts: [{ postedAt: '2026-10-21T10:00:00Z', day7: day7(100) }, { postedAt: '2026-10-22T10:00:00Z', day7: day7(300) },
        { postedAt: '2026-10-23T10:00:00Z', day7: day7(200) }, { postedAt: '2026-11-01T10:00:00Z', day7: null }],
    })] }, now);
    expect(s!.weeks.map(w => [w.start, w.end])).toEqual([['2026-10-06', '2026-10-12'], ['2026-10-13', '2026-10-19'],
      ['2026-10-20', '2026-10-26'], ['2026-10-27', '2026-11-02']]);
    const [, , w3, w4] = s!.weeks;
    expect(w3).toMatchObject({ posts: 3, viewsMedian: 200, viewsSamples: 3, engagementMedian: 0.1, followers: 120, note: null });
    // The newest week's post is not 7 days old: no views yet, said as such, never zero.
    expect(w4).toMatchObject({ posts: 1, viewsMedian: null, engagementMedian: null, followers: 150, note: 'too_new' });
    expect(s!.gaps).toEqual({});
  });

  it('marks weeks before the connection day and names what the platform does not provide', () => {
    const [s] = trendSeries({ windowDays: 90, connections: [conn({ source: 'postforme', connectedAt: '2026-10-15T00:00:00Z',
      posts: [{ postedAt: '2026-10-16T00:00:00Z', day7: { views: 50 } }] })] }, now);
    expect(s!.weeks).toHaveLength(12);
    expect(s!.weeks.filter(w => w.note === 'before_connected').map(w => w.end).at(-1)).toBe('2026-10-12');
    // An empty week before the connection was not recorded: missing, not "0 posts".
    expect(s!.weeks.filter(w => w.note === 'before_connected').every(w => w.posts === null)).toBe(true);
    expect(s!.connectedOn).toBe('2026-10-15');
    // Post for Me gives no follower history; views without likes/comments/shares give no engagement rate.
    expect(s!.gaps).toEqual({ followers: 'not_provided', engagement: 'not_provided' });
  });

  it('a new account with nothing settled yet is accumulating, not missing', () => {
    const [s] = trendSeries({ windowDays: 30, connections: [conn()] }, now);
    expect(s!.gaps).toEqual({ followers: 'accumulating', views: 'accumulating', engagement: 'accumulating' });
    expect(s!.weeks.every(w => w.posts === 0 && w.viewsMedian === null)).toBe(true);
  });

  it('a follower snapshot taken only today is still accumulating, not "not provided"', () => {
    const [s] = trendSeries({ windowDays: 30, connections: [conn({ followers: [{ date: isoDay(Math.floor(now / DAY_MS)), value: 80 }] })] }, now);
    expect(s!.gaps.followers).toBe('accumulating');
  });
});

describe('readTrend', () => {
  it('asks only for the caller and the server window, and refuses a malformed answer', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { windowDays: 30, connections: [conn()] }, error: null });
    const out = await readTrend({ rpc } as never, '00000000-0000-4000-8000-0000000a0009', 30, now);
    expect(rpc).toHaveBeenCalledWith('publish_monitor_trend_series', { a: '00000000-0000-4000-8000-0000000a0009', p_window_days: 30 });
    expect(out.series).toHaveLength(1);
    const bad = vi.fn().mockResolvedValue({ data: { windowDays: 30, connections: [{ id: 'x' }] }, error: null });
    await expect(readTrend({ rpc: bad } as never, '00000000-0000-4000-8000-0000000a0009', 30, now))
      .rejects.toMatchObject({ code: 'PUBLISH_MONITOR_UNAVAILABLE' });
  });
});
