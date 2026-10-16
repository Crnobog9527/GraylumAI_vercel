/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DetailIssue, DetailSection, JuryDetail, Seat } from './jury-events';
import { firstSentence, issuesByChapter } from './jury-adopt';
import { changeHunks } from './jury-hunks';
import { CHAPTER_DIGEST, REPORT_SUMMARY, type ChapterDigest } from './jury-mock-digest';
import { REPORT_CHAPTERS, WHOLE_DOCUMENT, type ReportChapter } from './jury-report';

export type ReaderChapter = {
  title: string; digest: ChapterDigest; body: string;
  section: DetailSection | null;
  /** Without a revision: the reviewers' issues about this chapter. */
  issues: (DetailIssue & { seat: Seat })[];
};

export type SummaryLine = { label: string; section: string; original: string; revised: string };

/**
 * What the result page reads besides the review: the reviewed report by chapter and, where they exist, the reading
 * aids (a chapter's one line and points, the report on one page). The prototype has mock aids; the real page has the
 * report's own chapters only, so a chapter's line is its first sentence and the one-page summary is left out.
 */
export type ReaderSource = {
  chapters: readonly ReportChapter[];
  digest?: Readonly<Record<string, ChapterDigest>>;
  summary?: readonly SummaryLine[];
};

export const MOCK_READER_SOURCE: ReaderSource = { chapters: REPORT_CHAPTERS, digest: CHAPTER_DIGEST, summary: REPORT_SUMMARY };

/** Chapter titles in report order, then the whole-document entry: the order issues and points are listed in. */
export const sectionOrder = (source: ReaderSource) => [...source.chapters.map(chapter => chapter.title), WHOLE_DOCUMENT];

/** Reading pace for the time estimate: Chinese prose, read carefully. */
const CHARS_PER_MINUTE = 400;

const WHOLE_DIGEST: ChapterDigest = { gist: '针对整份报告的意见，不属于某一章。', points: [] };

/**
 * The whole report as chapter cards, in report order, each with its digest, the summary's verdict and any issues.
 * Notes about the whole document (「全文」) get their own card after the last chapter, only when there are any (#1004).
 */
export function readerChapters(detail: JuryDetail, source: ReaderSource = MOCK_READER_SOURCE): ReaderChapter[] {
  const failed = detail.summary.status !== 'usable';
  const issues = failed ? issuesByChapter(detail, sectionOrder(source)) : [];
  const card = (title: string, body: string, digest: ChapterDigest): ReaderChapter => {
    const section = detail.summary.sections.find(item => item.section === title) ?? null;
    return {
      title, digest, body: section?.revised ?? body,
      section: failed ? null : section,
      issues: issues.find(group => group.section === title)?.items ?? [],
    };
  };
  const chapters = source.chapters.map(chapter => card(chapter.title, chapter.body,
    source.digest?.[chapter.title] ?? { gist: firstSentence(chapter.body) || chapter.name, points: [] }));
  const whole = card(WHOLE_DOCUMENT, '', WHOLE_DIGEST);
  return whole.section || whole.issues.length > 0 ? [...chapters, whole] : chapters;
}

/** Chapters the user has to look at: changed by the revision, or (without one) with issues. */
export const flaggedChapters = (chapters: readonly ReaderChapter[]) =>
  chapters.filter(chapter => chapter.section?.changed || chapter.issues.length > 0);

/** The one-page summary, with the revised wording where the revision changed that chapter; empty without one. */
export function summaryLines(detail: JuryDetail, source: ReaderSource = MOCK_READER_SOURCE) {
  return (source.summary ?? []).map(line => {
    const revised = detail.summary.sections.some(item => item.section === line.section && item.changed);
    return { label: line.label, section: line.section, text: revised ? line.revised : line.original, revised };
  });
}

/** Minutes to read what "only changes" shows: the summary, then each flagged chapter's why and changed sentences. */
export function readingMinutes(detail: JuryDetail, chapters: readonly ReaderChapter[], source: ReaderSource = MOCK_READER_SOURCE): number {
  const texts: string[] = summaryLines(detail, source).map(line => line.text);
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
