/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { REPORT_DATA_CHAPTER, REPORT_DATA_FIELDS, REPORT_DATA_FIELD_NAMES, type ReportDataField, type Spec } from './reportDataSpec';
import type { ReportData } from './reportData';

/**
 * REPORT-VISUAL, pure and shared by the page, the server and the export: the report's `##` chapters, which data
 * fields a hand edit touched (§6.2), and the strategy data as plain lines for the export (§6.3).
 */

export type ReportChapterText = { title: string; body: string };

/** Lines inside a fenced code block are never headings. */
export function headingLines(lines: string[], test: RegExp) {
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
  const lines = text.split('\n');
  const starts = headingLines(lines, /^##\s+\S/);
  if (starts.length === 0) return { preamble: text, chapters: [] };
  const chapters = starts.map((start, index) => ({
    title: lines[start].replace(/^##\s+/, '').trim(),
    body: lines.slice(start + 1, starts[index + 1] ?? lines.length).join('\n').trim(),
  }));
  return { preamble: lines.slice(0, starts[0]).join('\n').trim(), chapters };
}

const CHAPTER_NAMES = [...new Set(Object.values(REPORT_DATA_CHAPTER)), '见效时间'];

// A trailing bracket that states how long the CHAPTER should be is a writing hint for the model: a length marker
// (约 / 至少 / 建议 / 不超过 / 最多 / 以内 / 左右) with a chapter-sized count ("800 字", 3+ digits), or "字数".
// Brackets that say anything else stay: "约 3 个月", "3–10 个合格账号", "昵称建议 4 字，简介 20 字", "每天写 100 字".
const WRITING_HINT = /\s*[（(](?=[^（）()]*(?:[约約]|至少|建议|不超过|最多|以内|左右|字数))[^（）()]*(?:\d{3,}\s*字|字数)[^（）()]*[）)]\s*$/;
/** A chapter title as the reader sees it: without the writing hint. */
export const reportDisplayTitle = (title: string) => title.replace(WRITING_HINT, '').trim() || title;

/**
 * The Skill chapter a report chapter title stands for, if any: "五、对标账号分析（约 800 字）" and "变现路径（漏斗）" are
 * 对标账号分析 and 变现路径. Numbering and writing hints do not count; then the exact name, its start, or the name in it.
 */
export const reportChapterName = (title: string) => {
  const plain = reportDisplayTitle(title).replace(/^\s*(?:[一二三四五六七八九十]+|\d+)\s*[、.．]\s*/, '');
  return CHAPTER_NAMES.find(name => name === plain) ?? CHAPTER_NAMES.find(name => plain.startsWith(name))
    ?? CHAPTER_NAMES.find(name => plain.includes(name)) ?? CHAPTER_ALIASES.find(([phrase]) => plain.includes(phrase))?.[1];
};

/** The Skill words some chapters differently from the names the data is keyed by ("二、你真正想要的结果，以及这条路能不能走通"). */
const CHAPTER_ALIASES: ReadonlyArray<readonly [string, string]> = [['你真正想要的结果', '目标和可行性'], ['这条路能不能走通', '目标和可行性']];

/**
 * The data fields whose chapter text differs from the generated text (§6.2): a deterministic per-chapter comparison,
 * like the jury's changed-chapter check. A chapter changed back to its generated text is no longer marked.
 */
export function editedReportFields(generatedText: string, currentText: string): ReportDataField[] {
  const chapters = (text: string) => new Map(splitChapters(text).chapters
    .map(chapter => [reportChapterName(chapter.title) ?? chapter.title, chapter.body.replace(/\r\n?/g, '\n').trim()]));
  const before = chapters(generatedText);
  const after = chapters(currentText);
  return REPORT_DATA_FIELD_NAMES.filter(field => before.get(REPORT_DATA_CHAPTER[field]) !== after.get(REPORT_DATA_CHAPTER[field]));
}

/** One value as a short line of text: enum codes become their labels, lists are joined. */
export function cellText(spec: Spec, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (spec.kind) {
  case 'text': return String(value);
  case 'int': return String(value);
  case 'enum': return spec.values[String(value)] ?? '';
  case 'list': return (value as unknown[]).map(item => cellText(spec.of, item)).filter(Boolean).join('；');
  case 'object': return Object.entries(spec.fields)
    .map(([key, child]) => {
      const text = cellText(child, (value as Record<string, unknown>)[key]);
      return text ? `${child.label}：${text}` : '';
    }).filter(Boolean).join('，');
  }
}

export const REPORT_DATA_EDITED_NOTE = '这一项对应的报告文字被手动改过；如果不一致，以改过的文字为准。';

/**
 * Every field of the data as plain lines for the export, in field order: a list of records becomes one line per
 * record, anything else one line. `escape` is applied to every piece of text (the export escapes Markdown).
 */
export function reportDataLines(data: ReportData, textEdited: readonly string[], escape: (text: string) => string): string[] {
  const lines: string[] = [];
  const edited = new Set(textEdited);
  for (const field of REPORT_DATA_FIELD_NAMES) {
    const value = data[field];
    if (value === undefined) continue;
    const spec = REPORT_DATA_FIELDS[field] as Spec;
    lines.push(`### ${escape(spec.label)}`);
    if (edited.has(field)) lines.push(escape(REPORT_DATA_EDITED_NOTE));
    if (spec.kind === 'list') (value as unknown[]).forEach(item => lines.push(`- ${escape(cellText(spec.of, item))}`));
    else if (spec.kind === 'object') for (const [key, child] of Object.entries(spec.fields)) {
      const text = cellText(child, (value as Record<string, unknown>)[key]);
      if (text) lines.push(`- ${escape(child.label)}：${escape(text)}`);
    }
    else lines.push(escape(cellText(spec, value)));
  }
  return lines;
}
