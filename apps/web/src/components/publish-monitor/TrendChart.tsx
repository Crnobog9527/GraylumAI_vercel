'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import styles from './data-review.module.css';
import { axisTick, weekTicks, type SummaryGap } from './trend-summary';

/**
 * One weekly chart of the trend dashboard. The line is the workbench's ink; gold marks only the latest week that has
 * a value (DESIGN.md: gold is an accent, never a fill for the whole series). A week without data is a break in the
 * line, never a drop to zero, and a metric the platform does not give is named in words instead of drawn.
 */
export type ChartRow = { start: string; end: string; label: string; followers: number | null; viewsMedian: number | null;
  engagementPct: number | null; posts: number | null };
export type ChartKey = 'followers' | 'viewsMedian' | 'engagementPct' | 'posts';

const GAP_TEXT: Record<SummaryGap, string> = { not_provided: '这个平台不提供这项数据', accumulating: '数据积累中，满 7 天后开始显示' };
const INK = '#262626', GOLD = '#ffbb17', GRID = '#ededed';
const AXIS = { fontSize: 11, fill: '#6b6b6b' };
/** The widest tick is "1,400" or "12.5万" at 11px; the axis keeps its own room instead of a negative chart margin. */
const AXIS_WIDTH = 44;
/** A line's last point sits on the right edge, so half of its date label needs room there; a bar is centred in its band. */
const LINE_MARGIN = { top: 8, right: 20, bottom: 0, left: 0 };
const BAR_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };
const TOOLTIP = {
  contentStyle: { border: `1px solid ${GRID}`, borderRadius: 8, boxShadow: '0 14px 34px rgba(0,0,0,.13)', padding: '8px 10px',
    fontSize: 12, lineHeight: '18px', color: INK, background: '#fff' },
  labelStyle: { color: '#6b6b6b', marginBottom: 2 },
  itemStyle: { color: INK, padding: 0 },
};

export function TrendChart({ title, rows, dataKey, gap, format, bar = false, animate }: { title: string; rows: ChartRow[];
  dataKey: ChartKey; gap?: SummaryGap; format: (value: number) => string; bar?: boolean; animate: boolean }) {
  const latest = rows.findLastIndex(row => row[dataKey] !== null);
  const xAxis = <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval={0}
    ticks={weekTicks(rows.map(row => row.label))} />;
  return (
    <figure className={`${styles.chartCard} ${styles.rise}`}>
      <figcaption>{title}</figcaption>
      {gap ? <p className={styles.gap}>{GAP_TEXT[gap]}</p> : (
        <div className={styles.chartBox}>
          <ResponsiveContainer width="100%" height="100%">
            {bar ? (
              <BarChart data={rows} margin={BAR_MARGIN}>
                <CartesianGrid vertical={false} stroke={GRID} />
                {xAxis}
                <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={AXIS_WIDTH} tickFormatter={axisTick} />
                <Tooltip {...TOOLTIP} cursor={{ fill: '#f4f4f5' }} formatter={value => [format(Number(value)), title]}
                  labelFormatter={(_, payload) => weekRange(payload)} />
                <Bar dataKey={dataKey} name={title} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={animate}
                  animationDuration={400}>
                  {rows.map((row, index) => <Cell key={row.end} fill={index === latest ? GOLD : INK}
                    fillOpacity={index === latest ? 1 : 0.82} />)}
                </Bar>
              </BarChart>
            ) : (
              <LineChart data={rows} margin={LINE_MARGIN}>
                <CartesianGrid vertical={false} stroke={GRID} />
                {xAxis}
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={AXIS_WIDTH} tickFormatter={axisTick} />
                <Tooltip {...TOOLTIP} cursor={{ stroke: '#dcdcdc' }} formatter={value => [format(Number(value)), title]}
                  labelFormatter={(_, payload) => weekRange(payload)} />
                <Line dataKey={dataKey} name={title} stroke={INK} strokeWidth={2} strokeLinejoin="round" connectNulls={false}
                  isAnimationActive={animate} animationDuration={400} activeDot={{ r: 4, fill: INK, stroke: '#fff', strokeWidth: 2 }}
                  dot={({ cx, cy, index }) => (cx == null || cy == null ? <g key={index} /> : index === latest
                    ? <circle key={index} cx={cx} cy={cy} r={4.5} fill={GOLD} stroke="#fff" strokeWidth={2} />
                    : <circle key={index} cx={cx} cy={cy} r={2} fill={INK} />)} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}

function weekRange(payload: ReadonlyArray<{ payload?: unknown }>) {
  const week = payload[0]?.payload as ChartRow | undefined;
  return week ? `${week.start} 至 ${week.end}` : '';
}
