'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { trpc } from '@/trpc/client';
import { dataErrorMessage, errorCode, formatDay, formatMetric, platformName } from './labels';

/**
 * PUBLISH-MONITOR block A (Owner 2026-10-27): the weekly growth charts of the "数据复盘" page, one card per connected account
 * (platforms are never mixed). Every number comes from the server's trend query; a week without data is a gap in the line,
 * and a metric the platform does not give is named in words instead of drawn.
 */
export type TrendWeek = { start: string; end: string; posts: number; viewsMedian: number | null; viewsSamples: number;
  engagementMedian: number | null; followers: number | null; note: 'before_connected' | 'too_new' | null };
type Gap = 'not_provided' | 'accumulating';
export type TrendSeries = { connectionId: string; platform: string; businessName: string | null; connectedOn: string;
  weeks: TrendWeek[]; gaps: Partial<Record<'followers' | 'views' | 'engagement', Gap>> };

const GAP_TEXT: Record<Gap, string> = { not_provided: '这个平台不提供这项数据', accumulating: '数据积累中，满 7 天后开始显示' };
const AXIS = { fontSize: 11, fill: 'var(--text-secondary)' };
/** "10-27" for a week ending 2026-10-27: short enough for a 390px screen. */
const weekLabel = (w: TrendWeek) => w.end.slice(5);

export function TrendCharts({ gold }: { gold: boolean }) {
  const trend = trpc.publishMonitor.trend.useQuery(undefined, { retry: false });
  return (
    <section className="space-y-4" aria-labelledby="pm-trend">
      <div className="space-y-1">
        <h2 id="pm-trend" className="text-base font-semibold">数据趋势</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          按周统计，每周截至昨天。播放/浏览和互动率取作品发布满 7 天时的数据，只在同一个平台里比较。
          {gold ? '90 天趋势从连接日起记录。' : ''}</p>
      </div>
      {trend.isPending ? <p className="text-sm">正在读取…</p>
        : trend.error ? <p role="alert" className="text-sm">{dataErrorMessage(errorCode(trend.error))}</p>
          : (trend.data.series as TrendSeries[]).length === 0
            ? <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>还没有连接账号。连接后每天记录，第一周数据满 7 天后出现在这里。</p>
            : (trend.data.series as TrendSeries[]).map(s => <SeriesCard key={s.connectionId} series={s} gold={gold} />)}
    </section>
  );
}

function SeriesCard({ series, gold }: { series: TrendSeries; gold: boolean }) {
  const rows = series.weeks.map(w => ({ ...w, label: weekLabel(w),
    engagementPct: w.engagementMedian === null ? null : Number((w.engagementMedian * 100).toFixed(2)) }));
  const latest = series.weeks.at(-1);
  return (
    <article className="min-w-0 space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)' }}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{series.businessName ? `${series.businessName} · ` : ''}{platformName(series.platform)}</h3>
        {gold && <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>从 {formatDay(series.connectedOn)} 连接起记录</span>}
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <Chart title="粉丝" rows={rows} dataKey="followers" gap={series.gaps.followers} format={v => formatMetric('followers', v)} />
        <Chart title="每条作品播放/浏览（中位数）" rows={rows} dataKey="viewsMedian" gap={series.gaps.views}
          format={v => formatMetric('views', v)} />
        <Chart title="互动率（中位数）" rows={rows} dataKey="engagementPct" gap={series.gaps.engagement} format={v => `${v}%`} />
        <Chart title="发布频率（条/周）" rows={rows} dataKey="posts" bar format={v => `${v} 条`} />
      </div>
      <ul className="space-y-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {latest?.note === 'too_new' && <li>最近一周的作品还没满 7 天，播放和互动率下周再算。</li>}
        {series.weeks.some(w => w.note === 'before_connected') && <li>连接之前的周没有播放、互动和粉丝记录，图上留空。</li>}
        <li>互动率 = (点赞 + 评论 + 分享) ÷ 播放；缺任何一项的作品不算。</li>
      </ul>
    </article>
  );
}

type ChartRow = TrendWeek & { label: string; engagementPct: number | null };
function Chart({ title, rows, dataKey, gap, format, bar = false }: { title: string; rows: ChartRow[];
  dataKey: 'followers' | 'viewsMedian' | 'engagementPct' | 'posts'; gap?: Gap; format: (v: number) => string; bar?: boolean }) {
  return (
    <figure className="min-w-0 space-y-1">
      <figcaption className="text-xs font-medium">{title}</figcaption>
      {gap ? (
        <p className="flex h-40 items-center justify-center rounded border border-dashed text-xs"
          style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>{GAP_TEXT[gap]}</p>
      ) : (
        <div className="h-40 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            {bar ? (
              <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="var(--border-primary)" />
                <XAxis dataKey="label" tick={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
                <Tooltip formatter={v => format(Number(v))} labelFormatter={(_, p) => weekRange(p)} />
                <Bar dataKey={dataKey} fill="var(--chart-1)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
              </BarChart>
            ) : (
              <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="var(--border-primary)" />
                <XAxis dataKey="label" tick={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} />
                <Tooltip formatter={v => format(Number(v))} labelFormatter={(_, p) => weekRange(p)} />
                {/* A week without data is a break in the line, never a drop to zero. */}
                <Line dataKey={dataKey} stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 2 }} connectNulls={false}
                  isAnimationActive={false} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}

function weekRange(payload: ReadonlyArray<{ payload?: unknown }>) {
  const w = payload[0]?.payload as ChartRow | undefined;
  return w ? `${w.start} 至 ${w.end}` : '';
}
