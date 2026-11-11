'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { lazy, Suspense } from 'react';
import styles from './data-review.module.css';
import type { SummaryGap } from './trend-summary';

/**
 * One weekly chart of the trend dashboard: its card and title, or, for a metric the platform does not give, the
 * reason in words instead of a drawing. The drawing itself (TrendPlot.tsx, with the chart library) is downloaded on
 * demand; until it arrives the card keeps its size, so nothing moves.
 */
export type ChartRow = { start: string; end: string; label: string; followers: number | null; viewsMedian: number | null;
  engagementPct: number | null; posts: number | null };
export type ChartKey = 'followers' | 'viewsMedian' | 'engagementPct' | 'posts';

const GAP_TEXT: Record<SummaryGap, string> = { not_provided: '这个平台不提供这项数据', accumulating: '数据积累中，满 7 天后开始显示' };
const loadPlot = () => import('./TrendPlot');
const TrendPlot = lazy(loadPlot);
/** Starts the download of the drawing code early (the page calls it when it opens), so a chart is not later than its data. */
export const warmTrendPlot = () => { void loadPlot().catch(() => undefined); };

export function TrendChart({ title, rows, dataKey, gap, format, bar = false, animate }: { title: string; rows: ChartRow[];
  dataKey: ChartKey; gap?: SummaryGap; format: (value: number) => string; bar?: boolean; animate: boolean }) {
  return (
    <figure className={`${styles.chartCard} ${styles.rise}`}>
      <figcaption>{title}</figcaption>
      {gap ? <p className={styles.gap}>{GAP_TEXT[gap]}</p> : (
        <div className={styles.chartBox}>
          <Suspense fallback={<div className={styles.plotWait} aria-hidden="true" />}>
            <TrendPlot title={title} rows={rows} dataKey={dataKey} format={format} bar={bar} animate={animate} />
          </Suspense>
        </div>
      )}
    </figure>
  );
}
