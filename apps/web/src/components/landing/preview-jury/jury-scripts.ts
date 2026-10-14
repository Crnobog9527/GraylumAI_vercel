/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  summarize, type DecisionKey, type DetailDecision, type DetailIssue, type DetailResponse, type DetailRound, type DetailSection,
  type JuryDetail, type JuryEvent, type Seat, type Verdict,
} from './jury-events';
import {
  decisionsOf, ISSUES, RESPONSES, VERDICTS_AGREED, VERDICTS_ROUND_TWO, VERDICTS_SPLIT,
} from './jury-mock-reviews';
import { changedFieldCount, changedTitles, SECTIONS_CONSENSUS, SECTIONS_FULL } from './jury-mock-rulings';

/**
 * The three mock reviews. Each scenario has the owner's full record (fusionReview.detail) and the event list
 * (fusionReview.events), derived from it the way the backend does: summaries cut to 120 characters. Each arrival is
 * what a poll newly returns at a simulated server time; a reviewer's decisions and issues arrive together 10–30 s
 * after it started, nothing about its thinking arrives before that.
 */
type Draft = JuryEvent extends infer E ? E extends JuryEvent ? Omit<E, 'id'> : never : never;
export type MockArrival = { atMs: number; events: JuryEvent[] };
export type JuryScenarioId = 'full' | 'consensus' | 'failed';
export type JuryScenario = { id: JuryScenarioId; label: string; hint: string; detail: JuryDetail; arrivals: MockArrival[] };

const decisionEvent = (round: 1 | 2, reviewer: Seat, item: DetailDecision): Draft => ({
  type: 'decision', round, reviewer, decision: item.decision, verdict: item.verdict,
  strongestCase: summarize(item.strongestCase), strongestAlternative: summarize(item.strongestAlternative),
});
const issueEvent = (round: 1 | 2, reviewer: Seat, item: DetailIssue): Draft => ({
  type: 'issue', round, reviewer, section: item.location, perspective: item.perspective, severity: item.severity,
  problem: summarize(item.problem), fix: summarize(item.suggestion),
});
const responseEvent = (reviewer: Seat, item: DetailResponse): Draft => ({
  type: 'response', round: 2, reviewer, to: item.reviewer, decision: item.decision, stance: item.stance,
  strongestView: summarize(item.strongestView),
});

/** Everything a usable round of one seat says, in the order the backend lists it. */
function roundEvents(reviewer: Seat, round: DetailRound): Draft[] {
  if (round.status === 'failed') return [{ type: 'reviewer_failed', round: round.round, reviewer, reason: 'format' }];
  return [
    ...(round.responses ?? []).map(item => responseEvent(reviewer, item)),
    ...(round.decisions ?? []).map(item => decisionEvent(round.round, reviewer, item)),
    ...(round.issues ?? []).map(item => issueEvent(round.round, reviewer, item)),
  ];
}

function rulingEvents(list: DetailSection[]): Draft[] {
  return list.flatMap(section => section.rulings).map(item => ({
    type: 'adjudication', ...item, issue: summarize(item.issue), opinion: summarize(item.opinion),
    reason: summarize(item.reason), fix: summarize(item.fix),
  }));
}

const usable = (round: 1 | 2, decisions: DetailDecision[], extra: Omit<DetailRound, 'round' | 'status'> = {}): DetailRound =>
  ({ round, status: 'usable', decisions, ...extra });

function roundOne(seat: Seat, verdicts: Record<Seat, Record<DecisionKey, Verdict>>, issueCount?: number): DetailRound {
  return usable(1, decisionsOf(seat, verdicts), { issues: ISSUES[seat].slice(0, issueCount) });
}
const roundTwo = (seat: Seat) => usable(2, decisionsOf(seat, VERDICTS_ROUND_TWO), { responses: RESPONSES[seat], issues: [] });
const seatRounds = (seat: Seat, rounds: DetailRound[]) => ({ seat, rounds });
const roundOf = (detail: JuryDetail, seat: Seat, round: 1 | 2) =>
  detail.seats.find(item => item.seat === seat)?.rounds.find(item => item.round === round) as DetailRound;

const START: Draft[] = [{ type: 'review_started', reviewers: ['A', 'B', 'C'], sections: 13 }];
const startRound = (round: 1 | 2): Draft[] => (['A', 'B', 'C'] as const).map(reviewer => ({ type: 'reviewer_started', round, reviewer }));
const SPLITS: Draft[] = [
  { type: 'disagreement', decision: 'platform', keep: ['B', 'C'], change: ['A'] },
  { type: 'disagreement', decision: 'monetization', keep: ['A'], change: ['B', 'C'] },
];

function ready(list: DetailSection[]): Draft[] {
  const titles = changedTitles(list);
  return [
    ...rulingEvents(list),
    { type: 'revision_ready_for_choice', changedSections: titles.length, changedSectionTitles: titles,
      changedFields: changedFieldCount(list) },
    { type: 'review_ended', state: 'completed', outcome: 'revised' },
  ];
}

/** Gives each event a fixed id, as the backend does; ids carry no meaning and are never shown. */
function build(scenario: string, steps: [number, Draft[]][]): MockArrival[] {
  let count = 0;
  return steps.map(([atMs, drafts]) => ({ atMs, events: drafts.map(draft => ({ ...draft, id: `${scenario}-${++count}` }) as JuryEvent) }));
}

function splitDetail(id: string, failedB: boolean): JuryDetail {
  const two = (seat: Seat) => failedB && seat === 'B' ? { round: 2 as const, status: 'failed' as const } : roundTwo(seat);
  return {
    reviewId: id, state: failedB ? 'revision_failed' : 'completed', outcome: failedB ? 'opinions_only' : 'revised',
    revisionId: failedB ? null : 'mock-revision',
    seats: (['A', 'B', 'C'] as const).map(seat => seatRounds(seat, [roundOne(seat, VERDICTS_SPLIT), two(seat)])),
    summary: failedB ? { status: 'failed', sections: [] } : { status: 'usable', sections: SECTIONS_FULL },
    adoption: null,
    awaitingChoice: !failedB,
  };
}

const FULL = splitDetail('mock-full', false);
const FAILED = splitDetail('mock-failed', true);
const CONSENSUS: JuryDetail = {
  reviewId: 'mock-consensus', state: 'completed', outcome: 'revised', revisionId: 'mock-revision',
  seats: (['A', 'B', 'C'] as const).map(seat => seatRounds(seat, [roundOne(seat, VERDICTS_AGREED, 2)])),
  summary: { status: 'usable', sections: SECTIONS_CONSENSUS },
  adoption: null,
  awaitingChoice: true,
};

function splitRoundOne(detail: JuryDetail): [number, Draft[]][] {
  return [
    [0, START],
    [900, startRound(1)],
    [21_000, roundEvents('A', roundOf(detail, 'A', 1))],
    [27_500, roundEvents('C', roundOf(detail, 'C', 1))],
    [30_500, [...roundEvents('B', roundOf(detail, 'B', 1)), ...SPLITS]],
    [35_000, startRound(2)],
    [52_000, roundEvents('A', roundOf(detail, 'A', 2))],
  ];
}

export const JURY_SCENARIOS: readonly JuryScenario[] = [
  {
    id: 'full', label: '有分歧，辩论两轮', hint: '两个决定上意见不一，开第 2 轮，汇总裁决后写出修订稿',
    detail: FULL,
    arrivals: build('full', [
      ...splitRoundOne(FULL),
      [57_500, roundEvents('B', roundOf(FULL, 'B', 2))],
      [61_000, [...roundEvents('C', roundOf(FULL, 'C', 2)), { type: 'summary_started', round: 2 }]],
      [96_000, ready(SECTIONS_FULL)],
    ]),
  },
  {
    id: 'consensus', label: '没有分歧，提前结束', hint: '四个决定三人意见一致，不开第 2 轮，直接汇总',
    detail: CONSENSUS,
    arrivals: build('consensus', [
      [0, START],
      [900, startRound(1)],
      [19_000, roundEvents('A', roundOf(CONSENSUS, 'A', 1))],
      [24_000, roundEvents('B', roundOf(CONSENSUS, 'B', 1))],
      [30_500, [...roundEvents('C', roundOf(CONSENSUS, 'C', 1)), { type: 'summary_started', round: 1 }]],
      [62_000, ready(SECTIONS_CONSENSUS)],
    ]),
  },
  {
    id: 'failed', label: '修订稿没有生成成功', hint: '辩论完成，但汇总写出的修订稿没有通过检查，意见仍可参考',
    detail: FAILED,
    arrivals: build('failed', [
      ...splitRoundOne(FAILED),
      [58_000, roundEvents('B', roundOf(FAILED, 'B', 2))],
      [61_000, [...roundEvents('C', roundOf(FAILED, 'C', 2)), { type: 'summary_started', round: 2 }]],
      [92_000, [{ type: 'revision_failed', reason: 'REVISION_NOTES' },
        { type: 'review_ended', state: 'revision_failed', outcome: 'opinions_only' }]],
    ]),
  },
];

export function findScenario(id: string): JuryScenario {
  return JURY_SCENARIOS.find(scenario => scenario.id === id) ?? JURY_SCENARIOS[0];
}
