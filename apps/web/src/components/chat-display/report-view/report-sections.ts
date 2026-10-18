/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { REPORT_DATA_CHAPTER, REPORT_DATA_FIELD_NAMES, type ReportDataField } from "@repo/api/src/shared/reportDataSpec";
import { headingLines, reportChapterName, reportDisplayTitle } from "@repo/api/src/shared/reportDataText";
import type { ReportData } from "@repo/api/src/shared/reportData";

/**
 * REPORT-VISUAL §4, without React: cut the report text into its `##` chapters, fold each chapter's `### 理由`
 * part, and decide which chapter shows which strategy-data field. The report text itself is never rewritten.
 */

export const REASONS_HEADING = "理由";

/**
 * A chapter's conclusion and its reasons: everything from a `### 理由` line to the next `###` heading (or the
 * end) is the reasons, folded by default. A chapter without that line is all conclusion and shows in full.
 */
export function splitReasons(body: string): { main: string; reasons: string | null } {
  const lines = body.split("\n");
  const heads = headingLines(lines, /^###\s+\S/);
  const at = heads.find(index => lines[index].replace(/^###\s+/, "").trim() === REASONS_HEADING);
  if (at === undefined) return { main: body, reasons: null };
  const end = heads.find(index => index > at) ?? lines.length;
  const reasons = lines.slice(at + 1, end).join("\n").trim();
  const main = [...lines.slice(0, at), ...lines.slice(end)].join("\n").trim();
  return { main, reasons: reasons || null };
}

/**
 * Which fields each chapter shows, keyed by the chapter's index; fields whose chapter the report does not
 * have are `unplaced` and shown after the last chapter, so nothing in the data goes unseen.
 */
export function placeFields(data: ReportData, titles: string[], present: ReportDataField[] = presentFields(data)) {
  const byChapter = new Map<number, ReportDataField[]>();
  const unplaced: ReportDataField[] = [];
  for (const field of present) {
    const index = titles.findIndex(title => reportChapterName(title) === REPORT_DATA_CHAPTER[field]);
    if (index < 0) unplaced.push(field);
    else byChapter.set(index, [...(byChapter.get(index) ?? []), field]);
  }
  return { byChapter, unplaced };
}

export const presentFields = (data: ReportData) => REPORT_DATA_FIELD_NAMES.filter(field => data[field] !== undefined);

export { reportChapterName, reportDisplayTitle, splitChapters } from "@repo/api/src/shared/reportDataText";

/** Headings of the text without writing hints (display only; the stored text keeps them for the completeness check). */
export function withDisplayHeadings(text: string): string {
  const lines = text.split("\n");
  const heads = new Set(headingLines(lines, /^#{1,3}\s+\S/));
  return lines.map((line, index) => heads.has(index)
    ? line.replace(/^(#{1,3}\s+)(.+)$/, (_, mark: string, title: string) => mark + reportDisplayTitle(title)) : line).join("\n");
}

const count = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
/** 12345 → 1.2 万; smaller numbers as they are. */
export const formatCount = (value: number) => (value >= 10000 ? `${count.format(value / 10000)} 万` : count.format(value));
