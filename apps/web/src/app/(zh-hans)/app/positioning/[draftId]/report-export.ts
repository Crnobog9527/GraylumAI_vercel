/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { splitReportBody, type BenchmarkAccount, type SanitizedReportData } from "@repo/api/src/shared/reportData";
import { reportDataLines } from "@repo/api/src/shared/reportDataText";
import { formatApproxCount, isYoutube, withDisplayHeadings } from "@/components/chat-display/report-view/report-sections";

/**
 * 导出报告 (MASTER_PLAN §2.1 item 50 "已生成的报告仍可看、可导出"; 2026-10-12 旧版本报告可导出). PDF is out (D6),
 * so the file is Markdown, like 导出已确认资料. The report text stays Markdown so its chapters and tables read as they
 * do on the page; raw HTML and images are neutralized. The strategy data follows as "策略要点" with the same lines
 * as the server's version export (REPORT-VISUAL §6.3), never the raw data block. Pure: no React, no requests.
 */

export const REPORT_EXPORT_TEXT = {
  action: "导出报告",
  reading: "正在读取…",
  done: "已下载报告。",
  failed: "暂时无法读取报告，请稍后重试。",
  filename: "完整运营策略报告.md",
} as const;

/** The report's text as Markdown: no raw HTML, no images (a link to an image still shows as a link). */
function safeMarkdown(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/!\[/g, "!\\[");
}

/** One piece of data as literal text (the same escaping as the server's version export). */
function literal(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1");
}

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const shown = (value: number | null | undefined, format: (value: number) => string = number.format) =>
  typeof value === "number" ? format(value) : "没查到";

/** The host's benchmark numbers (never the model's), as on the page's benchmark table. Empty without numbers. */
function benchmarkTable(data: SanitizedReportData["data"]): string[] {
  const accounts = (data.benchmarks?.accounts ?? []) as BenchmarkAccount[];
  if (!accounts.some(account => account.metrics)) return [];
  // The table's rows stay on consecutive lines (the document joins its parts with blank lines).
  return ["### 对标账号数据", ["| 账号 | 平台 | 粉丝 | 中位播放 | 互动率 | 每周更新 |", "| --- | --- | --- | --- | --- | --- |",
    ...accounts.map(account => "| " + [literal(account.account), literal(account.platform), shown(account.metrics?.followers,
      value => isYoutube(account.platform) ? `${formatApproxCount(value)}（YouTube 只公开约数）` : number.format(value)),
      shown(account.metrics?.medianViews), shown(account.metrics?.engagementRate, value => `${number.format(value * 100)}%`),
      shown(account.metrics?.weeklyPosts, value => `${number.format(value)} 次`)].join(" | ") + " |")].join("\n")];
}

export type ReportExportSource = {
  /** The stored body (data block included). */
  body: string;
  /** The server-checked strategy data, when the report has it. */
  strategy?: { data: SanitizedReportData; textEdited?: readonly string[] } | null;
  /** Lines said once under the title: incomplete, edited, finalized. */
  notes?: string[];
};

export function reportExportMarkdown({ body, strategy, notes = [] }: ReportExportSource): string {
  const text = splitReportBody(body).text.trim();
  const data = strategy?.data.data;
  const points = data ? [...reportDataLines(data, strategy?.textEdited ?? [], literal), ...benchmarkTable(data)] : [];
  return [
    "# 完整运营策略报告",
    ...notes.map(note => `> ${literal(note)}`),
    safeMarkdown(withDisplayHeadings(text)),
    ...(points.length ? ["## 策略要点", ...points] : []),
  ].join("\n\n") + "\n";
}

export function downloadReport(markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = REPORT_EXPORT_TEXT.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
