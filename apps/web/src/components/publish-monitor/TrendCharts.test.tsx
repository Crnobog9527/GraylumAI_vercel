/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ trend: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { trend: { useQuery: () => state.trend } } } }));
import { TrendCharts, type TrendSeries, type TrendWeek } from './TrendCharts';

const text = (html: string) => html.replace(/<[^>]*>/g, '');
const week = (end: string, over: Partial<TrendWeek> = {}): TrendWeek => ({ start: end, end, posts: 2, viewsMedian: 300,
  viewsSamples: 2, engagementMedian: 0.05, followers: 120, note: null, ...over });
const series = (over: Partial<TrendSeries> = {}): TrendSeries => ({ connectionId: 'c1', platform: 'youtube', businessName: '家常菜',
  connectedOn: '2026-10-15', weeks: [week('2026-10-12', { note: 'before_connected', viewsMedian: null, followers: null }),
    week('2026-10-19'), week('2026-11-02', { note: 'too_new', viewsMedian: null, engagementMedian: null })], gaps: {}, ...over });
const ok = (data: unknown) => ({ isPending: false, error: null, data });

beforeEach(() => { state.trend = ok({ windowDays: 90, series: [series()] }); });

describe('trend charts', () => {
  it('one card per brand account with four charts; Gold says data is recorded from the connection day', () => {
    const html = text(renderToStaticMarkup(<TrendCharts gold />));
    expect(html).toContain('家常菜 · YouTube');
    for (const title of ['粉丝', '每条作品播放/浏览（中位数）', '互动率（中位数）', '发布频率（条/周）']) expect(html).toContain(title);
    expect(html).toContain('从 2026-10-15 连接起记录');
    expect(html).toContain('90 天趋势从连接日起记录');
    expect(html).toContain('最近一周的作品还没满 7 天');
    expect(html).toContain('连接之前的周没有播放、互动和粉丝记录');
  });

  it('names a metric the platform does not give instead of drawing it, and Pro does not claim a 90-day record', () => {
    state.trend = ok({ windowDays: 30, series: [series({ gaps: { followers: 'not_provided', engagement: 'accumulating' } })] });
    const html = text(renderToStaticMarkup(<TrendCharts gold={false} />));
    expect(html).toContain('这个平台不提供这项数据');
    expect(html).toContain('数据积累中，满 7 天后开始显示');
    expect(html).not.toContain('连接起记录');
  });

  it('no account yet, and a read failure, are said in words', () => {
    state.trend = ok({ windowDays: 30, series: [] });
    expect(text(renderToStaticMarkup(<TrendCharts gold={false} />))).toContain('还没有连接账号');
    state.trend = { isPending: false, error: { message: 'PUBLISH_MONITOR_UNAVAILABLE', data: {} }, data: undefined };
    expect(renderToStaticMarkup(<TrendCharts gold={false} />)).toContain('role="alert"');
  });

  it('while reading shows a wordless skeleton, never loading text or a spinner', () => {
    state.trend = { isPending: true };
    const html = renderToStaticMarkup(<TrendCharts gold={false} />);
    expect(html).toContain('data-testid="trend-skeleton"');
    expect(text(html)).not.toMatch(/读取|加载/);
    expect(html).not.toContain('animate-spin');
  });
});
