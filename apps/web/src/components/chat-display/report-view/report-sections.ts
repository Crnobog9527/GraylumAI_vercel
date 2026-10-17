/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { REPORT_DATA_CHAPTER, REPORT_DATA_FIELD_NAMES, type ReportDataField } from "@repo/api/src/shared/reportDataSpec";
import type { ReportData } from "@repo/api/src/shared/reportData";

/**
 * REPORT-VISUAL §4, without React: cut the report text into its `##` chapters, fold each chapter's `### 理由`
 * part, and decide which chapter shows which strategy-data field. The report text itself is never rewritten.
 */

export type ReportChapterText = { title: string; body: string };

/** Lines inside a fenced code block are never headings. */
function headingLines(lines: string[], test: RegExp) {
  const found: number[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && test.test(line)) found.push(index);
  });
  return found;
}

/** The text before the first `## ` chapter, and the chapters in order. */
export function splitChapters(text: string): { preamble: string; chapters: ReportChapterText[] } {
  const lines = text.split("\n");
  const starts = headingLines(lines, /^##\s+\S/);
  if (starts.length === 0) return { preamble: text, chapters: [] };
  const chapters = starts.map((start, index) => ({
    title: lines[start].replace(/^##\s+/, "").trim(),
    body: lines.slice(start + 1, starts[index + 1] ?? lines.length).join("\n").trim(),
  }));
  return { preamble: lines.slice(0, starts[0]).join("\n").trim(), chapters };
}

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

/** Titles may carry a note (`变现路径（漏斗）`): the Skill's chapter name at the start is what counts. */
const chapterOf = (title: string, chapters: string[]) =>
  chapters.find(name => name === title) ?? chapters.find(name => title.startsWith(name));

/**
 * Which fields each chapter shows, keyed by the chapter's index; fields whose chapter the report does not
 * have are `unplaced` and shown after the last chapter, so nothing in the data goes unseen.
 */
export function placeFields(data: ReportData, titles: string[], present: ReportDataField[] = presentFields(data)) {
  const names = [...new Set(Object.values(REPORT_DATA_CHAPTER))];
  const byChapter = new Map<number, ReportDataField[]>();
  const unplaced: ReportDataField[] = [];
  for (const field of present) {
    const index = titles.findIndex(title => chapterOf(title, names) === REPORT_DATA_CHAPTER[field]);
    if (index < 0) unplaced.push(field);
    else byChapter.set(index, [...(byChapter.get(index) ?? []), field]);
  }
  return { byChapter, unplaced };
}

export const presentFields = (data: ReportData) => REPORT_DATA_FIELD_NAMES.filter(field => data[field] !== undefined);

/** The Skill chapter a report chapter title stands for, if any. */
export const reportChapterName = (title: string) => chapterOf(title, [...new Set(Object.values(REPORT_DATA_CHAPTER)), "见效时间"]);

const count = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
/** 12345 → 1.2 万; smaller numbers as they are. */
export const formatCount = (value: number) => (value >= 10000 ? `${count.format(value / 10000)} 万` : count.format(value));
