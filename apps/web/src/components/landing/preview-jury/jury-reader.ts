/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DetailIssue, DetailSection, JuryDetail, Seat } from './jury-events';
import { firstSentence, issuesByChapter } from './jury-adopt';
import { changeHunks } from './jury-hunks';
import { CHAPTER_DIGEST, REPORT_SUMMARY, type ChapterDigest } from './jury-mock-digest';
import { REPORT_SECTIONS } from './jury-mock-reviews';
import { REPORT_CHAPTERS } from './jury-report';

export type ReaderChapter = {
  title: string; digest: ChapterDigest; body: string;
  section: DetailSection | null;
  /** Without a revision: the reviewers' issues about this chapter. */
  issues: (DetailIssue & { seat: Seat })[];
};

/** Reading pace for the time estimate: Chinese prose, read carefully. */
const CHARS_PER_MINUTE = 400;

/** The whole report as chapter cards, in report order, each with its digest, the summary's verdict and any issues. */
export function readerChapters(detail: JuryDetail): ReaderChapter[] {
  const failed = detail.summary.status !== 'usable';
  const issues = failed ? issuesByChapter(detail, REPORT_SECTIONS) : [];
  return REPORT_CHAPTERS.map(chapter => {
    const section = detail.summary.sections.find(item => item.section === chapter.title) ?? null;
    const digest = CHAPTER_DIGEST[chapter.title] ?? { gist: chapter.name, points: [] };
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
export function summaryLines(detail: JuryDetail) {
  return REPORT_SUMMARY.map(line => {
    const revised = detail.summary.sections.some(item => item.section === line.section && item.changed);
    return { label: line.label, section: line.section, text: revised ? line.revised : line.original, revised };
  });
}

/** Minutes to read what "only changes" shows: the summary, then each flagged chapter's why and changed sentences. */
export function readingMinutes(detail: JuryDetail, chapters: readonly ReaderChapter[]): number {
  const texts: string[] = summaryLines(detail).map(line => line.text);
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
