/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { JuryCase } from '@/components/landing/preview-jury/jury-case';
import {
  summarize, type DetailRound, type JuryEvent, type RulingFields, type Seat,
} from '@/components/landing/preview-jury/jury-events';
import { J_REPORT, J_REVISION } from '@/lib/landing/landing-copy-j-takeover';
import { OFFICE_WORKER_REPORT } from '@/lib/landing/sample-reports/office-worker';
import { plainText } from '@/lib/landing/sample-reports/report-markdown';
import { asCanvasPlace, J_REVIEW_SEATS, J_REVIEW_SPLITS, J_RULINGS } from './jury-review-j';

export { asCanvasPlace };

/**
 * The jury canvas (#1002's, brief) playing this page's real review (jury-review-j.ts): the reports it shows are this
 * person's original and revised reports; the events are made from the review the way the backend makes them (texts
 * cut to 120 characters), arriving on the prototype's timing. The shared canvas is not changed.
 */
type Draft = JuryEvent extends infer E ? E extends JuryEvent ? Omit<E, 'id'> : never : never;

const SEATS = ['A', 'B', 'C'] as const;
const roundOf = (seat: Seat, round: 1 | 2) =>
  J_REVIEW_SEATS.find(item => item.seat === seat)?.rounds.find(item => item.round === round) as DetailRound;

function roundEvents(reviewer: Seat, round: DetailRound): Draft[] {
  return [
    ...(round.responses ?? []).map((item): Draft => ({
      type: 'response', round: 2, reviewer, to: item.reviewer, decision: item.decision, stance: item.stance,
      strongestView: summarize(item.strongestView),
    })),
    ...(round.decisions ?? []).map((item): Draft => ({
      type: 'decision', round: round.round, reviewer, decision: item.decision, verdict: item.verdict,
      strongestCase: summarize(item.strongestCase), strongestAlternative: summarize(item.strongestAlternative),
    })),
    ...(round.issues ?? []).map((item): Draft => ({
      type: 'issue', round: round.round, reviewer, section: item.location, perspective: item.perspective, severity: item.severity,
      problem: summarize(item.problem), fix: summarize(item.suggestion),
    })),
  ];
}

const ruling = (item: RulingFields): Draft => ({
  type: 'adjudication', ...item, issue: summarize(item.issue), opinion: summarize(item.opinion),
  reason: summarize(item.reason), fix: summarize(item.fix),
});

const changed = J_REVISION.changes.map(change => asCanvasPlace(change.chapter));
const STEPS: [number, Draft[]][] = [
  [0, [{ type: 'review_started', reviewers: [...SEATS], sections: 13 }]],
  [900, SEATS.map((reviewer): Draft => ({ type: 'reviewer_started', round: 1, reviewer }))],
  [21_000, roundEvents('A', roundOf('A', 1))],
  [27_500, roundEvents('C', roundOf('C', 1))],
  [30_500, [...roundEvents('B', roundOf('B', 1)), ...J_REVIEW_SPLITS.map((split): Draft => ({ type: 'disagreement', ...split }))]],
  [35_000, SEATS.map((reviewer): Draft => ({ type: 'reviewer_started', round: 2, reviewer }))],
  [52_000, roundEvents('A', roundOf('A', 2))],
  [57_500, roundEvents('B', roundOf('B', 2))],
  [61_000, [...roundEvents('C', roundOf('C', 2)), { type: 'summary_started', round: 2 }]],
  [96_000, [
    ...J_RULINGS.map(ruling),
    { type: 'revision_ready_for_choice', changedSections: changed.length, changedSectionTitles: changed, changedFields: 0 },
    { type: 'review_ended', state: 'completed', outcome: 'revised' },
  ]],
];

let count = 0;
const arrivals = STEPS.map(([atMs, drafts]) => ({
  atMs, events: drafts.map(draft => ({ ...draft, id: `landing-j-${++count}` }) as JuryEvent),
}));

const conclusion = (list: readonly { markdown: string }[]) => plainText(list[0]?.markdown ?? '');

export const J_JURY_CASE: JuryCase = {
  report: {
    title: J_REPORT.title,
    excerpt: conclusion(OFFICE_WORKER_REPORT.original),
    chapters: J_REPORT.chapters.length - 1,
    revisedExcerpt: conclusion(OFFICE_WORKER_REPORT.revised),
  },
  arrivals,
};
