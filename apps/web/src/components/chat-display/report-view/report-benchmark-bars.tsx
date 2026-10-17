/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { Bar, BarChart, LabelList, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { BenchmarkAccount } from "@repo/api/src/shared/reportData";
import { formatCount } from "./report-sections";
import styles from "./report-view.module.css";

/**
 * The benchmark bars (REPORT-VISUAL §4, chart 3), loaded only when at least one account has numbers from the
 * host's benchmark table. One small horizontal bar chart per number, since followers and views differ in scale.
 */
export default function BenchmarkBars({ accounts }: { accounts: BenchmarkAccount[] }) {
  const series = [
    { key: "followers" as const, title: "粉丝数" },
    { key: "medianViews" as const, title: "近期中位播放" },
  ];
  return (
    <div className={styles.bars}>
      {series.map(({ key, title }) => {
        const rows = accounts.filter(account => typeof account.metrics?.[key] === "number")
          .map(account => ({ name: account.account, value: account.metrics![key] as number }));
        if (rows.length === 0) return null;
        return (
          <div key={key} className={styles.barChart}>
            <p className={styles.blockTitle}>{title}</p>
            <div aria-hidden="true" style={{ height: 36 * rows.length + 16 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={110} tickLine={false} axisLine={false} fontSize={12} />
                  <Bar dataKey="value" fill="currentColor" fillOpacity={0.55} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                    <LabelList dataKey="value" position="right" formatter={(value: unknown) => formatCount(Number(value))} fontSize={12} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}
