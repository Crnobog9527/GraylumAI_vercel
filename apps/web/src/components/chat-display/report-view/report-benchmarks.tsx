/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { lazy, Suspense } from "react";
import { REPORT_DATA_FIELDS } from "@repo/api/src/shared/reportDataSpec";
import type { BenchmarkAccount, ReportData } from "@repo/api/src/shared/reportData";
import { ReportDataBlock } from "./report-data-table";
import { formatCount } from "./report-sections";
import { REPORT_VIEW_TEXT as T } from "./report-text";
import styles from "./report-view.module.css";

/** recharts is only downloaded for a report that has benchmark numbers. */
const BenchmarkBars = lazy(() => import("./report-benchmark-bars"));

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const percent = (value: number) => `${number.format(value * 100)}%`;
const shown = (value: number | null | undefined, format: (value: number) => string) =>
  typeof value === "number" ? format(value) : "—";

const ACCOUNT = REPORT_DATA_FIELDS.benchmarks.fields.accounts.of.fields;

/**
 * Chart 3: benchmark accounts. Numbers come only from the host's own benchmark table (filled into `metrics`,
 * REPORT-VISUAL §3.3); the model's text never supplies a number. Without numbers, only what to learn is listed.
 */
export function BenchmarkChart({ benchmarks }: { benchmarks: NonNullable<ReportData["benchmarks"]> }) {
  const accounts = benchmarks.accounts as BenchmarkAccount[];
  const measured = accounts.some(account => account.metrics && (account.metrics.followers !== null || account.metrics.medianViews !== null));
  const summary = accounts.map(account => [account.account,
    account.metrics?.followers != null ? `粉丝 ${formatCount(account.metrics.followers)}` : "",
    account.metrics?.medianViews != null ? `中位播放 ${formatCount(account.metrics.medianViews)}` : "",
  ].filter(Boolean).join("，")).join("；");
  return (
    <figure className={styles.block}>
      <figcaption className={styles.blockTitle}>{REPORT_DATA_FIELDS.benchmarks.fields.accounts.label}</figcaption>
      {accounts.length > 0 && (measured
        ? <>
          <p className={styles.srOnly}>{summary}</p>
          <Suspense fallback={<p className={styles.note}>{T.preparing}</p>}><BenchmarkBars accounts={accounts} /></Suspense>
        </>
        : <p className={styles.note}>{T.noMetrics}</p>)}
      {accounts.length > 0 && <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead><tr>
            <th scope="col">{ACCOUNT.account.label}</th><th scope="col">{ACCOUNT.platform.label}</th>
            {measured && <><th scope="col">互动率</th><th scope="col">每周更新</th></>}
            <th scope="col">{ACCOUNT.category.label}</th><th scope="col">{ACCOUNT.takeaway.label}</th>
          </tr></thead>
          <tbody>{accounts.map((account, index) => (
            <tr key={index}>
              <td>{account.account}</td><td>{account.platform}</td>
              {measured && <><td>{shown(account.metrics?.engagementRate, percent)}</td>
                <td>{shown(account.metrics?.weeklyPosts, value => `${number.format(value)} 次`)}</td></>}
              <td>{account.category}</td><td>{account.takeaway}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>}
      {benchmarks.todo && <ReportDataBlock spec={REPORT_DATA_FIELDS.benchmarks.fields.todo} value={benchmarks.todo} />}
    </figure>
  );
}
