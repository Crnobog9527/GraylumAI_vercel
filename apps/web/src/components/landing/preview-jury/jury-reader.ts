/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DetailIssue, DetailSection, JuryDetail, Seat } from './jury-events';
import { firstSentence, issuesByChapter } from './jury-adopt';
import { changeHunks } from './jury-hunks';
import { CHAPTER_DIGEST, REPORT_SUMMARY, type ChapterDigest } from './jury-mock-digest';
import { REPORT_SECTIONS } from './jury-mock-reviews';
import { REPORT_CHAPTERS, type ReportChapter } from './jury-report';

export type ReaderChapter = {
  title: string; digest: ChapterDigest; body: string;
  section: DetailSection | null;
  /** Without a revision: the reviewers' issues about this chapter. */
  issues: (DetailIssue & { seat: Seat })[];
};

/**
 * The report the result page reads: its chapters, a digest per chapter, the one-page summary and the chapter order
 * the summary uses. The prototype's mock report by default; a caller with its own report (the landing page's sample)
 * passes it in, and the review's sections must name the same chapters.
 */
export type ReaderReport = {
  chapters: readonly ReportChapter[];
  digest: Readonly<Record<string, ChapterDigest>>;
  summary: readonly { label: string; section: string; original: string; revised: string }[];
  sections: readonly string[];
};
export const PROTOTYPE_REPORT: ReaderReport = {
  chapters: REPORT_CHAPTERS, digest: CHAPTER_DIGEST, summary: REPORT_SUMMARY, sections: REPORT_SECTIONS,
};

/** Reading pace for the time estimate: Chinese prose, read carefully. */
const CHARS_PER_MINUTE = 400;

/** The whole report as chapter cards, in report order, each with its digest, the summary's verdict and any issues. */
export function readerChapters(detail: JuryDetail, report: ReaderReport = PROTOTYPE_REPORT): ReaderChapter[] {
  const failed = detail.summary.status !== 'usable';
  const issues = failed ? issuesByChapter(detail, report.sections) : [];
  return report.chapters.map(chapter => {
    const section = detail.summary.sections.find(item => item.section === chapter.title) ?? null;
    const digest = report.digest[chapter.title] ?? { gist: chapter.name, points: [] };
    return {
      title: chapter.title, digest,
      body: section?.revised ?? chapter.body ?? '',
      section: failed ? null : section,
      issues: issues.find(group => group.section === chapter.title)?.items ?? [],
    };
  });
}

/** Chapters the user has to look at: changed by the revision, or (without one) with issues. */
export const flaggedChapters = (chapters: readonly ReaderChapter[]) =>
  chapters.filter(chapter => chapter.section?.changed || chapter.issues.length > 0);

/** The one-page summary, with the revised wording where the revision changed that chapter. */
export function summaryLines(detail: JuryDetail, report: ReaderReport = PROTOTYPE_REPORT) {
  return report.summary.map(line => {
    const revised = detail.summary.sections.some(item => item.section === line.section && item.changed);
    return { label: line.label, section: line.section, text: revised ? line.revised : line.original, revised };
  });
}

/** Minutes to read what "only changes" shows: the summary, then each flagged chapter's why and changed sentences. */
export function readingMinutes(detail: JuryDetail, chapters: readonly ReaderChapter[], report: ReaderReport = PROTOTYPE_REPORT): number {
  const texts: string[] = summaryLines(detail, report).map(line => line.text);
  for (const chapter of flaggedChapters(chapters)) {
    const section = chapter.section;
    const primary = section?.rulings.find(item => item.adopted) ?? section?.rulings[0];
    if (primary) texts.push(primary.opinion, firstSentence(primary.reason));
    if (section?.changed) {
      for (const hunk of changeHunks(section.original ?? '', section.revised ?? '')) {
        if (hunk.type === 'change') texts.push(hunk.before, hunk.after);
        if (hunk.type === 'context') texts.push(hunk.text);
      }
    }
    for (const issue of chapter.issues) texts.push(firstSentence(issue.problem));
  }
  const chars = texts.reduce((sum, text) => sum + Array.from(text).length, 0);
  return Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE));
}
