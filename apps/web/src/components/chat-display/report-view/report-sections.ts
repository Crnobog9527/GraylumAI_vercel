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

/** Writing hints the Skill puts at the end of a chapter title for the model, never for the reader: "（约 800 字，…）". */
const WRITING_HINT = /\s*[（(]\s*约[^（）()]*[）)]\s*$/;
/** A chapter title as the reader sees it: without the writing hint. */
export const reportDisplayTitle = (title: string) => title.replace(WRITING_HINT, "").trim() || title;

/** Headings of the text without writing hints (display only; the stored text keeps them for the completeness check). */
export function withDisplayHeadings(text: string): string {
  const lines = text.split("\n");
  const heads = new Set(headingLines(lines, /^#{1,3}\s+\S/));
  return lines.map((line, index) => heads.has(index)
    ? line.replace(/^(#{1,3}\s+)(.+)$/, (_, mark: string, title: string) => mark + reportDisplayTitle(title)) : line).join("\n");
}

/** "五、对标账号分析（约 800 字）" stands for 对标账号分析: numbering and hints do not count, then the name in the title. */
const chapterOf = (title: string, chapters: string[]) => {
  const plain = reportDisplayTitle(title).replace(/^\s*(?:[一二三四五六七八九十]+|\d+)\s*[、.．]\s*/, "");
  return chapters.find(name => name === plain) ?? chapters.find(name => plain.startsWith(name)) ?? chapters.find(name => plain.includes(name));
};

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
