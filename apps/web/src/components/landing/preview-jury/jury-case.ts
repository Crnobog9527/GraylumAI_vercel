/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { JuryEvent } from './jury-events';
import { REVISION_TEXT } from './jury-mock-rulings';
import { REPORT_CHAPTERS, REPORT_TITLE } from './jury-report';
import { findScenario, type JuryScenarioId, type MockArrival } from './jury-scripts';

/**
 * A case the canvas can play: the two reports it shows (before and after) and the review's events, in the shapes of
 * FUSION-REVIEW.md §2.2a. The reviewers' result cards, the rulings and the counts all come from the events; only the
 * report texts are extra. The prototype's own mock creator is one case; the landing page passes its own.
 */
export type JuryCaseReport = {
  /** Shown on the original report card, and with 修订后的 in front of it on the new report card. */
  title: string;
  /** Two or three lines from the start of the original report; longer text is cut with an ellipsis. */
  excerpt: string;
  /** Number of chapters, shown as "13 章". */
  chapters: number;
  /** The start of the revised report: best the text of the first changed chapters. */
  revisedExcerpt: string;
};
/** Events as a poll returns them: each arrival is what came back at a server time (ms from the review's start). */
export type JuryArrival = MockArrival;
export type JuryCase = { report: JuryCaseReport; arrivals: readonly JuryArrival[] };

export const MOCK_REPORT: JuryCaseReport = {
  title: REPORT_TITLE,
  excerpt: REPORT_CHAPTERS.slice(0, 2).map(chapter => chapter.body).join(' '),
  chapters: REPORT_CHAPTERS.length,
  revisedExcerpt: Object.values(REVISION_TEXT).slice(0, 2).map(text => text.revised).join(' '),
};

export function mockCase(id: JuryScenarioId): JuryCase {
  return { report: MOCK_REPORT, arrivals: findScenario(id).arrivals };
}

/**
 * A case from a plain event list, when there are no real arrival times (a written example): events arrive in order,
 * one reviewer's answer at a time, `gapMs` apart. Enough for the brief replay and for scroll-driven playback.
 */
export function caseFromEvents(report: JuryCaseReport, events: readonly JuryEvent[], gapMs = 1500): JuryCase {
  return { report, arrivals: events.map((event, index) => ({ atMs: index * gapMs, events: [event] })) };
}
