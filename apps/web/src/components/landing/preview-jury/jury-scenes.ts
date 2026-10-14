/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DECISIONS, SEATS, type DecisionKey, type EventOf, type JuryEvent, type Seat, type Verdict } from './jury-events';
import type { MockArrival } from './jury-scripts';

/**
 * Pure playback plan: the received events become a row of scenes, and the stage shows one scene at a time.
 * A scene never starts before the events it shows have arrived; while nothing new has arrived, a waiting scene
 * (reviewers reading, the summary writing) holds the stage. Durations are reading time at 1×.
 */
export const STAGES = [
  { key: 'seated', label: '入席' },
  { key: 'reading', label: '各自审阅' },
  { key: 'steelman', label: '钢人判断' },
  { key: 'critique', label: '挑刺' },
  { key: 'divergence', label: '找分歧' },
  { key: 'debate', label: '第 2 轮辩论' },
  { key: 'ruling', label: '汇总裁决' },
  { key: 'revision', label: '修订稿' },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];

export const BEAT = {
  seated: 4500, readingMin: 5000, submitGap: 700, settle: 2500, steelman: 8000, issueLead: 1400, issue: 4200,
  divergence: 7500, agreed: 5000, response: 8500, failed: 5000, writingMin: 5500, ruling: 5200, revision: 6500,
} as const;

type Received = { event: JuryEvent; arrivedAt: number };
export type SteelmanCard = { seat: Seat; verdict: Verdict; strongestCase: string; strongestAlternative: string };

type Payload =
  | { kind: 'seated'; sections: number }
  | { kind: 'reading'; round: 1 | 2; submitAt: Partial<Record<Seat, number>>; failed: Seat[] }
  | { kind: 'steelman'; decision: DecisionKey; index: number; cards: SteelmanCard[] }
  | { kind: 'critique'; seat: Seat; issues: EventOf<'issue'>[] }
  | { kind: 'divergence'; split: EventOf<'disagreement'>; index: number; total: number; cards: SteelmanCard[] }
  | { kind: 'agreed' }
  | { kind: 'response'; response: EventOf<'response'>; verdictNow: Verdict | null }
  | { kind: 'failed'; failure: EventOf<'reviewer_failed'> }
  | { kind: 'writing'; round: 1 | 2 }
  | { kind: 'ruling'; ruling: EventOf<'adjudication'>; index: number; total: number }
  | { kind: 'revision'; result: EventOf<'revision_ready_for_choice'> | EventOf<'revision_failed'> };
export type Scene = Payload & { stage: StageKey; start: number; end: number };
export type SceneKind = Scene['kind'];

const STAGE_OF: Record<SceneKind, StageKey> = {
  seated: 'seated', reading: 'reading', steelman: 'steelman', critique: 'critique', divergence: 'divergence', agreed: 'divergence',
  response: 'debate', failed: 'debate', writing: 'ruling', ruling: 'ruling', revision: 'revision',
};

function received(arrivals: readonly MockArrival[]): Received[] {
  // Play each id once, in list order (the backend's list is append-only by real time).
  const seen = new Set<string>();
  return arrivals
    .flatMap(arrival => arrival.events.map(event => ({ event, arrivedAt: arrival.atMs })))
    .filter(item => !seen.has(item.event.id) && Boolean(seen.add(item.event.id)));
}

export function buildScenes(arrivals: readonly MockArrival[]): Scene[] {
  const list = received(arrivals);
  const scenes: Scene[] = [];
  let cursor = 0;
  const of = <T extends JuryEvent['type']>(type: T, test: (event: EventOf<T>) => boolean = () => true) =>
    list.filter((item): item is { event: EventOf<T>; arrivedAt: number } => item.event.type === type && test(item.event as EventOf<T>));
  const latest = (items: Received[]) => Math.max(0, ...items.map(item => item.arrivedAt));
  const push = (payload: Payload, length: number, ready = 0) => {
    const start = Math.max(cursor, ready);
    cursor = start + length;
    const stage = payload.kind === 'reading' && payload.round === 2 ? 'debate' : STAGE_OF[payload.kind];
    scenes.push({ ...payload, stage, start, end: cursor } as Scene);
  };
  /** A waiting scene: holds until every seat of the round has answered (or failed), then lets submissions settle. */
  const reading = (round: 1 | 2) => {
    const said = list.filter(item => 'round' in item.event && item.event.round === round && item.event.type !== 'reviewer_started');
    const first = (seat: Seat) => said.find(item => 'reviewer' in item.event && item.event.reviewer === seat);
    const start = Math.max(cursor, latest(of('reviewer_started', event => event.round === round)));
    const submitAt: Partial<Record<Seat, number>> = {};
    SEATS.forEach((seat, index) => {
      const answer = first(seat);
      if (answer) submitAt[seat] = Math.max(answer.arrivedAt, start + 1200 + index * BEAT.submitGap);
    });
    const failed = of('reviewer_failed', event => event.round === round).map(item => item.event.reviewer);
    const done = Math.max(start + BEAT.readingMin, ...Object.values(submitAt).map(at => at + BEAT.settle));
    push({ kind: 'reading', round, submitAt, failed }, done - start, start);
  };

  const started = of('review_started')[0];
  if (!started) return scenes;
  push({ kind: 'seated', sections: started.event.sections }, BEAT.seated);

  reading(1);
  const roundOne = of('decision', event => event.round === 1);
  const cardsOf = (decision: DecisionKey): SteelmanCard[] => roundOne.filter(item => item.event.decision === decision)
    .map(({ event }) => ({
      seat: event.reviewer, verdict: event.verdict, strongestCase: event.strongestCase, strongestAlternative: event.strongestAlternative,
    }))
    .sort((left, right) => SEATS.indexOf(left.seat) - SEATS.indexOf(right.seat));
  DECISIONS.forEach((decision, index) => {
    const cards = cardsOf(decision);
    if (cards.length > 0) push({ kind: 'steelman', decision, index, cards }, BEAT.steelman);
  });
  for (const seat of SEATS) {
    const issues = of('issue', event => event.round === 1 && event.reviewer === seat).map(item => item.event);
    if (issues.length > 0) push({ kind: 'critique', seat, issues }, BEAT.issueLead + issues.length * BEAT.issue);
  }
  for (const failure of of('reviewer_failed', event => event.round === 1)) {
    push({ kind: 'failed', failure: failure.event }, BEAT.failed, failure.arrivedAt);
  }

  const splits = of('disagreement');
  splits.forEach((split, index) => push(
    { kind: 'divergence', split: split.event, index, total: splits.length, cards: cardsOf(split.event.decision) }, BEAT.divergence,
  ));
  if (splits.length === 0 && of('summary_started').length > 0) push({ kind: 'agreed' }, BEAT.agreed);

  if (of('reviewer_started', event => event.round === 2).length > 0) {
    reading(2);
    const roundTwo = of('decision', event => event.round === 2);
    for (const item of list) {
      if (item.event.type === 'response') {
        const { reviewer, decision } = item.event;
        const now = roundTwo.find(entry => entry.event.reviewer === reviewer && entry.event.decision === decision);
        push({ kind: 'response', response: item.event, verdictNow: now?.event.verdict ?? null }, BEAT.response, item.arrivedAt);
      }
      if (item.event.type === 'reviewer_failed' && item.event.round === 2) {
        push({ kind: 'failed', failure: item.event }, BEAT.failed, item.arrivedAt);
      }
    }
  }

  const summary = of('summary_started')[0];
  if (summary) {
    const output = list.filter(item => ['adjudication', 'revision_ready_for_choice', 'revision_failed'].includes(item.event.type));
    const start = Math.max(cursor, summary.arrivedAt);
    const until = output.length > 0 ? latest(output) + 1500 : start + BEAT.writingMin;
    push({ kind: 'writing', round: summary.event.round }, Math.max(BEAT.writingMin, until - start), start);
    const rulings = of('adjudication');
    rulings.forEach((ruling, index) => push({ kind: 'ruling', ruling: ruling.event, index, total: rulings.length }, BEAT.ruling));
    const result = output.find(item => item.event.type !== 'adjudication');
    if (result) push({ kind: 'revision', result: result.event as Extract<Payload, { kind: 'revision' }>['result'] }, BEAT.revision);
  }
  return scenes;
}

export const playbackLength = (scenes: readonly Scene[]) => scenes[scenes.length - 1]?.end ?? 0;

/** The scene on stage at a clock time: the last one that has started. */
export function sceneAt(scenes: readonly Scene[], clock: number): Scene | null {
  let found: Scene | null = null;
  for (const scene of scenes) if (scene.start <= clock) found = scene;
  return found;
}

export const stageIndex = (key: StageKey) => STAGES.findIndex(item => item.key === key);

/** Stations passed over: when everyone agrees there is no debate round. */
export function skippedStages(scenes: readonly Scene[]): StageKey[] {
  return scenes.some(scene => scene.kind === 'agreed') ? ['debate'] : [];
}

/** mm:ss of a playback clock. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
