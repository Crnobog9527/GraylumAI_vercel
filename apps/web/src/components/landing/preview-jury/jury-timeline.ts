/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  DECISIONS, SEATS, type DecisionKey, type JuryEvent, type JuryEventType, type Seat, type SeatCode, type Verdict,
} from './jury-events';
import type { MockArrival } from './jury-scripts';

/**
 * Pure playback: when each received event is shown, and what the stage looks like at a given clock time.
 * An event is never shown before it has arrived; arrived events are shown one by one with a reading pause each,
 * and the pauses shrink when many are waiting so the replay does not lag far behind the real review.
 */
export type TimedEvent = { event: JuryEvent; order: number; arrivedAt: number; revealAt: number };

/** Reading pause after each event at 1×, in ms; sized so a 120-character summary can be read. */
export const REVEAL_PAUSE: Record<JuryEventType, number> = {
  review_started: 2600,
  reviewer_started: 700,
  decision: 4200,
  issue: 3200,
  reviewer_failed: 2600,
  disagreement: 3800,
  response: 5200,
  summary_started: 1600,
  adjudication: 3000,
  revision_ready: 2400,
  revision_failed: 2400,
  review_ended: 0,
};

export function scheduleReveals(arrivals: readonly MockArrival[]): TimedEvent[] {
  // Play each id once, in list order (the backend's list is append-only by real time).
  const seen = new Set<string>();
  const received = arrivals
    .flatMap(arrival => arrival.events.map(event => ({ event, arrivedAt: arrival.atMs })))
    .filter(item => !seen.has(item.event.id) && Boolean(seen.add(item.event.id)))
    .map((item, order) => ({ ...item, order }));
  const timed: TimedEvent[] = [];
  let cursor = 0;
  received.forEach((item, index) => {
    const revealAt = Math.max(item.arrivedAt, cursor);
    const backlog = received.slice(index + 1).filter(next => next.arrivedAt <= revealAt).length;
    const factor = backlog > 8 ? 0.6 : backlog > 4 ? 0.8 : 1;
    timed.push({ ...item, revealAt });
    cursor = revealAt + REVEAL_PAUSE[item.event.type] * factor;
  });
  return timed;
}

export function playbackLength(timed: readonly TimedEvent[]): number {
  const last = timed[timed.length - 1];
  return last ? last.revealAt + REVEAL_PAUSE[last.event.type] : 0;
}

/** The ceremony's stations, in order. Each one lights up only when an event of it has been shown. */
export const STAGES = [
  { key: 'seated', label: '入席' },
  { key: 'reading', label: '独立审阅' },
  { key: 'steelman', label: '钢人判断' },
  { key: 'critique', label: '挑刺' },
  { key: 'divergence', label: '找分歧' },
  { key: 'debate', label: '第 2 轮辩论' },
  { key: 'ruling', label: '汇总裁决' },
  { key: 'revision', label: '修订稿' },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];

export function stageOf(event: JuryEvent): StageKey | null {
  switch (event.type) {
    case 'review_started': return 'seated';
    case 'reviewer_started': return event.round === 2 ? 'debate' : 'reading';
    case 'decision': return 'steelman';
    case 'issue': return event.round === 2 ? 'debate' : 'critique';
    case 'reviewer_failed': return event.round === 2 ? 'debate' : 'critique';
    case 'disagreement': return 'divergence';
    case 'response': return 'debate';
    case 'summary_started': case 'adjudication': return 'ruling';
    case 'revision_ready': case 'revision_failed': case 'review_ended': return 'revision';
    default: return null;
  }
}

export type SeatPhase = 'idle' | 'thinking' | 'ready' | 'speaking' | 'done' | 'failed';
export type SeatState = { phase: SeatPhase; round: 0 | 1 | 2; since: number };
type Of<T extends JuryEventType> = Extract<JuryEvent, { type: T }>;

export type JuryView = {
  sections: number;
  stage: number;
  /** Stations passed over: no disagreement means no divergence debate. */
  skipped: StageKey[];
  seats: Record<Seat, SeatState>;
  summary: SeatState;
  verdicts: Record<DecisionKey, Partial<Record<Seat, Verdict>>>;
  disagreements: Of<'disagreement'>[];
  issues: Of<'issue'>[];
  responses: Of<'response'>[];
  failures: Of<'reviewer_failed'>[];
  rulings: Of<'adjudication'>[];
  revision: Of<'revision_ready'> | Of<'revision_failed'> | null;
  ended: boolean;
  /** The statement on the podium: the latest shown event that says something. */
  current: JuryEvent | null;
  /** True while the latest call started has said nothing yet: the podium shows the wait instead. */
  waiting: boolean;
  /** Every shown statement, oldest first, for the record. */
  feed: JuryEvent[];
};

const SPOKEN = new Set<JuryEventType>(['decision', 'issue', 'reviewer_failed', 'response', 'disagreement', 'adjudication',
  'revision_ready', 'revision_failed']);
const speakerOf = (event: JuryEvent): SeatCode | null =>
  'reviewer' in event ? event.reviewer
    : event.type === 'adjudication' || event.type === 'revision_ready' || event.type === 'revision_failed' ? 'S' : null;

function seatState(timed: readonly TimedEvent[], seat: SeatCode, now: number, current: TimedEvent | null): SeatState {
  const isStart = (event: JuryEvent) => seat === 'S' ? event.type === 'summary_started'
    : event.type === 'reviewer_started' && event.reviewer === seat;
  const start = [...timed].reverse().find(item => item.revealAt <= now && isStart(item.event));
  if (!start) return { phase: 'idle', round: 0, since: 0 };
  const round = 'round' in start.event ? start.event.round : 1;
  const sameRound = (event: JuryEvent) => seat === 'S' || ('round' in event && event.round === round);
  const own = timed.filter(item => item.order > start.order && speakerOf(item.event) === seat && SPOKEN.has(item.event.type)
    && sameRound(item.event));
  const arrived = own.filter(item => item.arrivedAt <= now);
  if (arrived.length === 0) return { phase: 'thinking', round, since: start.revealAt };
  const shown = arrived.filter(item => item.revealAt <= now);
  if (shown.some(item => item.event.type === 'reviewer_failed' || item.event.type === 'revision_failed')) {
    return { phase: 'failed', round, since: shown[0].revealAt };
  }
  const ended = timed.some(item => item.revealAt <= now && item.event.type === 'review_ended');
  if (!ended && current && speakerOf(current.event) === seat && shown.length > 0) {
    return { phase: 'speaking', round, since: shown[0].revealAt };
  }
  if (shown.length < own.length) return { phase: 'ready', round, since: arrived[0].arrivedAt };
  return { phase: 'done', round, since: shown[shown.length - 1].revealAt };
}

export function deriveView(timed: readonly TimedEvent[], now: number): JuryView {
  const shownTimed = timed.filter(item => item.revealAt <= now);
  const shown = shownTimed.map(item => item.event);
  const pick = <T extends JuryEventType>(type: T) => shown.filter((event): event is Of<T> => event.type === type);
  const currentTimed = [...shownTimed].reverse().find(item => SPOKEN.has(item.event.type)) ?? null;
  const current = currentTimed?.event ?? null;
  const lastStart = Math.max(-1, ...shownTimed.filter(item => item.event.type.endsWith('_started')).map(item => item.order));
  const verdicts = Object.fromEntries(DECISIONS.map(key => [key, {}])) as JuryView['verdicts'];
  for (const decision of pick('decision')) {
    if (decision.round === 1) verdicts[decision.decision][decision.reviewer] = decision.verdict;
  }
  const stages = shown.map(stageOf).filter((key): key is StageKey => key !== null);
  const stage = Math.max(-1, ...stages.map(key => STAGES.findIndex(item => item.key === key)));
  const skipped: StageKey[] = pick('summary_started').length > 0 && pick('disagreement').length === 0 ? ['divergence', 'debate'] : [];
  const revision = shown.find((event): event is Of<'revision_ready'> | Of<'revision_failed'> =>
    event.type === 'revision_ready' || event.type === 'revision_failed') ?? null;
  return {
    sections: pick('review_started')[0]?.sections ?? 0,
    stage,
    skipped,
    seats: Object.fromEntries(SEATS.map(seat => [seat, seatState(timed, seat, now, currentTimed)])) as Record<Seat, SeatState>,
    summary: seatState(timed, 'S', now, currentTimed),
    verdicts,
    disagreements: pick('disagreement'),
    issues: pick('issue'),
    responses: pick('response'),
    failures: pick('reviewer_failed'),
    rulings: pick('adjudication'),
    revision,
    ended: pick('review_ended').length > 0,
    current,
    feed: shown.filter(event => SPOKEN.has(event.type)),
    waiting: !currentTimed || currentTimed.order < lastStart,
  };
}

/** mm:ss of a playback clock, for the honest "elapsed" readouts. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
