'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { ChartNoAxesColumn } from 'lucide-react';
import { trpc } from '@/trpc/client';
import styles from './data-review.module.css';
import { dataErrorMessage, errorCode, formatDay, formatMetric, platformName } from './labels';
import { StateBlock } from './StateBlock';
import { TrendChart, type ChartRow } from './TrendChart';
import { trendKpis, type Kpi, type SummaryGap } from './trend-summary';

/**
 * PUBLISH-MONITOR block A (Owner 2026-10-27): the weekly growth dashboard of the "数据复盘" page. One connected account
 * is shown at a time (platforms are never mixed): its four headline numbers, then its four charts. Every number comes
 * from the server's trend query; a week without data is a gap in the line, and a metric the platform does not give is
 * named in words instead of drawn.
 */
export type TrendWeek = { start: string; end: string; posts: number | null; viewsMedian: number | null; viewsSamples: number;
  engagementMedian: number | null; followers: number | null; note: 'before_connected' | 'too_new' | null };
export type TrendSeries = { connectionId: string; platform: string; businessName: string | null; connectedOn: string;
  weeks: TrendWeek[]; gaps: Partial<Record<'followers' | 'views' | 'engagement', SummaryGap>> };

const KPI_GAP: Record<SummaryGap, string> = { not_provided: '平台不提供', accumulating: '数据积累中' };
/** "10-27" for a week ending 2026-10-27: short enough for a 360px screen. */
const weekLabel = (week: { end: string }) => week.end.slice(5);
const seriesName = (series: TrendSeries) => `${series.businessName ? `${series.businessName} · ` : ''}${platformName(series.platform)}`;
/** Charts draw in once, unless the system asks for less motion (also the answer where there is no window). */
const motionAllowed = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function TrendCharts({ gold, onOpenTab }: { gold: boolean; onOpenTab?: (tab: 'accounts' | 'import') => void }) {
  const trend = trpc.publishMonitor.trend.useQuery(undefined, { retry: false });
  const [picked, setPicked] = useState<string | null>(null);
  const all = (trend.data?.series ?? []) as TrendSeries[];
  // A picked account that was disconnected since falls back to the first one.
  const shown = all.find(series => series.connectionId === picked) ?? all[0];
  return (
    <section aria-labelledby="pm-trend">
      <h2 id="pm-trend" className={styles.srOnly}>数据趋势</h2>
      <p className={styles.lead}>
        按周统计，每周截至昨天。播放/浏览和互动率取作品发布满 7 天时的数据，只在同一个平台里比较。
        {gold ? '90 天趋势从连接日起记录。' : ''}</p>
      {trend.isPending ? <TrendSkeleton />
        : trend.error ? <StateBlock tone="error" title="暂时读不到趋势数据" text={dataErrorMessage(errorCode(trend.error))} />
          : !shown ? (
            <StateBlock icon={<ChartNoAxesColumn size={20} aria-hidden />} title="还没有连接账号"
              text="连接后每天记录，第一周数据满 7 天后出现在这里。">
              {onOpenTab && <>
                <button type="button" className={styles.button} onClick={() => onOpenTab('accounts')}>连接账号</button>
                <button type="button" className={styles.buttonQuiet} onClick={() => onOpenTab('import')}>用表格导入</button>
              </>}
            </StateBlock>
          ) : <>
            {all.length > 1 && (
              <div className={styles.chips} role="group" aria-label="选择账号">
                {all.map(series => (
                  <button key={series.connectionId} type="button" className={styles.chip}
                    aria-pressed={series.connectionId === shown.connectionId} onClick={() => setPicked(series.connectionId)}>
                    {seriesName(series)}</button>
                ))}
              </div>
            )}
            <SeriesView key={shown.connectionId} series={shown} gold={gold} named={all.length === 1} />
          </>}
    </section>
  );
}

/** While the query runs: the dashboard's shape with no words or spinner (Owner: no "loading" text on pages). */
export function TrendSkeleton() {
  return (
    <div aria-busy="true" data-testid="trend-skeleton" className={styles.stack}>
      <div className={styles.kpis}>{[0, 1, 2, 3].map(i => <div key={i} className={`${styles.sk} ${styles.skKpi}`} />)}</div>
      <div className={styles.charts}>{[0, 1, 2, 3].map(i => <div key={i} className={`${styles.sk} ${styles.skChart}`} />)}</div>
    </div>
  );
}

/** `named`: with one account its name is the heading; with several the pressed switch above already names it. */
function SeriesView({ series, gold, named }: { series: TrendSeries; gold: boolean; named: boolean }) {
  // Decided once per account view: the charts draw in when the account is opened, not on every re-render.
  const [animate] = useState(motionAllowed);
  const rows: ChartRow[] = series.weeks.map(week => ({ start: week.start, end: week.end, label: weekLabel(week),
    followers: week.followers, viewsMedian: week.viewsMedian, posts: week.posts,
    engagementPct: week.engagementMedian === null ? null : Number((week.engagementMedian * 100).toFixed(2)) }));
  const latest = series.weeks.at(-1);
  const recordedFrom = gold ? `从 ${formatDay(series.connectedOn)} 连接起记录` : null;
  return (
    <article className={styles.stack}>
      {named ? (
        <header className={styles.accountHead}>
          <h3>{seriesName(series)}</h3>
          {recordedFrom && <span>{recordedFrom}</span>}
        </header>
      ) : <h3 className={styles.srOnly}>{seriesName(series)}</h3>}
      <dl className={styles.kpis}>
        {trendKpis(series.weeks, series.gaps).map(kpi => <KpiTile key={kpi.key} kpi={kpi} />)}
      </dl>
      <div className={styles.charts}>
        <TrendChart title="粉丝" rows={rows} dataKey="followers" gap={series.gaps.followers} animate={animate}
          format={value => formatMetric('followers', value)} />
        <TrendChart title="每条作品播放/浏览（中位数）" rows={rows} dataKey="viewsMedian" gap={series.gaps.views} animate={animate}
          format={value => formatMetric('views', value)} />
        <TrendChart title="互动率（中位数）" rows={rows} dataKey="engagementPct" gap={series.gaps.engagement} animate={animate}
          format={value => `${value}%`} />
        <TrendChart title="发布频率（条/周）" rows={rows} dataKey="posts" bar animate={animate} format={value => `${value} 条`} />
      </div>
      <ul className={styles.notes}>
        {!named && recordedFrom && <li>{recordedFrom}。</li>}
        {latest?.note === 'too_new' && <li>最近一周的作品还没满 7 天，播放和互动率下周再算。</li>}
        {series.weeks.some(week => week.note === 'before_connected')
          && <li>连接之前的周没有播放、互动和粉丝记录，没有记录的发布频率也留空，不算 0 条。</li>}
        <li>互动率 = (点赞 + 评论 + 分享) ÷ 播放；缺任何一项的作品不算。</li>
      </ul>
    </article>
  );
}

/** One headline number: the latest week that has a value, and its change against the week right before it. */
function KpiTile({ kpi }: { kpi: Kpi }) {
  return (
    <div className={`${styles.kpi} ${styles.rise}`}>
      <dt>{kpi.label}</dt>
      <dd>
        <span className={styles.kpiValue} data-empty={kpi.value === null}>{kpi.value ?? '—'}</span>
        <span className={styles.kpiNote}>
          {kpi.value === null ? (kpi.gap ? KPI_GAP[kpi.gap] : '还没有数据') : <>
            {kpi.delta && <span className={styles.delta} data-direction={kpi.delta.direction}>
              {kpi.delta.direction === 'up' ? '↑ ' : kpi.delta.direction === 'down' ? '↓ ' : ''}{kpi.delta.text}</span>}
            <span>{kpi.delta ? '比上一周 · ' : ''}截至 {kpi.weekEnd!.slice(5)}</span>
          </>}
        </span>
      </dd>
    </div>
  );
}
