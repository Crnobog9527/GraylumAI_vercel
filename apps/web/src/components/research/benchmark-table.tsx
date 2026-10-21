/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABELS, cellSourceNumbers, cellText, COLUMNS, numberSources, type BenchmarkRow,
} from "./benchmark-table-model";
import { DATA_SOURCE_NOTE, MISSING_TEXT, platformLabel } from "./research-model";
import { RefreshButton } from "./refresh-button";
import styles from "./research-table.module.css";

const formatFetchedAt = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Benchmark table (plan §1.4): followers, median views, engagement rate, posting frequency and last update per
 * account. Every number cites its source number; a number the evidence cannot support reads "这次没查到".
 * In a narrow column (a chat) the table scrolls sideways and the account column stays on one line; on a phone each
 * account becomes a stacked block with the column names inline.
 */
export function BenchmarkTable({ rows, now = new Date(), onRefresh, refreshDisabled = false, fetchedAt, children, note }: {
  rows: BenchmarkRow[];
  now?: Date;
  /** When the newest row was fetched (ISO time), shown in the viewer's own time. */
  fetchedAt?: string | null;
  /** Extra notes under the table, e.g. how many qualified benchmarks the report still needs. */
  children?: ReactNode;
  /** Asks the host for a refresh grant for one row; absent = no refresh buttons (e.g. a read-only report). */
  onRefresh?: (row: BenchmarkRow) => Promise<void>;
  /** The conversation cannot take a message now: the refresh buttons stay visible but locked. */
  refreshDisabled?: boolean;
  /** The line under the table; absent = where the data comes from and how a missing figure shows (the product's). */
  note?: string;
}) {
  const { entries, numberOf } = numberSources(rows);
  const qualified = rows.filter(row => row.qualified).length;
  return (
    <section aria-label="对标表" className={styles.wrap}>
      <div className={styles.top}>
        <p className={styles.head}>对标表</p>
        <p className={styles.summary}>{rows.length} 个账号 · 数据条件达标 {qualified} 个</p>
      </div>
      <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">账号</th>
            {COLUMNS.map(column => <th key={column.key} scope="col">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={`${row.platform}:${row.account}`} data-qualified={row.qualified}>
              <th scope="row" className={styles.account}>
                <span className={styles.accountName}>{row.account}</span>
                <span className={styles.accountMeta}>
                  {platformLabel(row.platform)}
                  {row.category && <span className={styles.category}>{CATEGORY_LABELS[row.category]}</span>}
                  <span className={cn(styles.badge, row.qualified ? styles.ok : styles.off)}>
                    {row.qualified ? "数据条件达标" : "只作参考"}
                  </span>
                </span>
                {onRefresh && <RefreshButton account={row.account} disabled={refreshDisabled} onRefresh={() => onRefresh(row)} />}
              </th>
              {COLUMNS.map(column => {
                const value = cellText(row, column.key, now);
                const sources = cellSourceNumbers(row, column.key, numberOf);
                const missing = value === MISSING_TEXT;
                return (
                  <td key={column.key} data-label={column.label} className={cn(missing && styles.missing)}>
                    <span>{value}</span>
                    {sources.length > 0 && (
                      <sup className={styles.ref} aria-label={`来源 ${sources.join("、")}`}>[{sources.join(",")}]</sup>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {entries.length > 0 && (
        <ol aria-label="数据来源" className={styles.sources}>
          {entries.map(entry => (
            <li key={entry.evidenceId}>[{entry.number}] {entry.account} 的数据来源记录（编号 {entry.evidenceId}）</li>
          ))}
        </ol>
      )}
      {fetchedAt && <p className={styles.note}>查询时间：{formatFetchedAt(fetchedAt)}</p>}
      <p className={styles.note}>数据条件达标仅指粉丝量、近期更新和作品数量符合筛选条件；内容主题是否适合你，仍需结合具体作品判断。</p>
      {children}
      {onRefresh && <p className={styles.note}>点“刷新”会重新读取这个账号的最新数据，算一次新的查询。</p>}
      <p className={styles.note}>{note ?? `${DATA_SOURCE_NOTE}缺失的数字标为“${MISSING_TEXT}”，不按 0 计算。`}</p>
    </section>
  );
}
