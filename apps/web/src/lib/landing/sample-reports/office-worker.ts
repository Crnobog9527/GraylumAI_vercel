/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import data from './office-worker.json';
import { REPORT_CHAPTER_TITLES, splitReport } from './report-markdown';

/**
 * The page's own person (林一舟, fictional: "下班后 15 分钟家常菜"), run through the real positioning Skill and then the
 * review Skill on 2026-10-15: the original report, and the revised report after the jury. Both sanitized (the
 * suggested @handles dropped). The takeover's report window shows the original; the jury's result page the revision.
 */
const original = splitReport(data.original);
const revised = splitReport(data.revised);

export const OFFICE_WORKER_REPORT = {
  generatedAt: data.generatedAt,
  title: original.title,
  original: REPORT_CHAPTER_TITLES.map((title, index) => ({ title, markdown: original.chapters[index]?.markdown ?? '' })),
  revised: REPORT_CHAPTER_TITLES.map((title, index) => ({ title, markdown: revised.chapters[index]?.markdown ?? '' })),
} as const;
