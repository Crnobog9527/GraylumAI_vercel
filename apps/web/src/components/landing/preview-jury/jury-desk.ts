/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SEATS, type EventOf, type Seat, type SeatCode, type Verdict } from './jury-events';
import { DECISION_SECTION } from './jury-mock-reviews';
import { REPORT_CHAPTERS, WHOLE_DOCUMENT } from './jury-report';
import { BEAT, type Scene, type StageKey, type SteelmanCard } from './jury-scenes';

/**
 * Pure read-out of what the annotated document shows at a clock time: which chapter the stage is about, where each
 * reviewer is reading, and the notes in each chapter's margin. Notes build up stage by stage the way a shared review
 * does; each stage decides which earlier notes stay in full, shrink to one line, or step aside.
 */
export type Reply = { response: EventOf<'response'>; verdictNow: Verdict | null; turned: boolean; current: boolean };
export type MarginItem =
  | { kind: 'decision'; key: string; cards: SteelmanCard[]; decision: EventOf<'decision'>['decision']; open: boolean; revealed: number }
  | { kind: 'issue'; key: string; seat: Seat; issue: EventOf<'issue'>; tone: 'current' | 'normal' | 'quiet'; stamp: boolean | null }
  | { kind: 'split'; key: string; split: EventOf<'disagreement'>; cards: SteelmanCard[]; replies: Reply[]; current: boolean; compact?: boolean }
  | { kind: 'ruling'; key: string; ruling: EventOf<'adjudication'>; current: boolean; compact: boolean };

export type Mode = StageKey | 'final';
export type DeskView = {
  mode: Mode;
  focus: string | null;
  /** Key of the note the stage is about right now (an issue, decision, split, reply or ruling), kept in view. */
  current: string | null;
  /** Chapter each reviewer (or the summary while writing) is reading right now. */
  reading: Partial<Record<SeatCode, string>>;
  notes: Record<string, MarginItem[]>;
  /** Changed chapters whose redline is showing. */
  redline: string[];
  revisionFailed: boolean;
};

export const READ_STEP = 2600;
export const STEEL_ROW = { lead: 900, gap: 650 } as const;
export const REDLINE = { lead: 400, gap: 700 } as const;

const chapterAt = (local: number, offset: number) =>
  REPORT_CHAPTERS[(Math.floor(Math.max(0, local) / READ_STEP) + offset) % REPORT_CHAPTERS.length].title;

export function issueIndexAt(scene: Extract<Scene, { kind: 'critique' }>, clock: number): number {
  const elapsed = clock - scene.start - BEAT.issueLead;
  return elapsed < 0 ? -1 : Math.min(scene.issues.length - 1, Math.floor(elapsed / BEAT.issue));
}

/** A reply states the other side's strongest view first, then where its author stands. */
export const replyTurned = (scene: Scene, clock: number) => clock - scene.start > BEAT.response * 0.45;

const section = (title: string) => (title === WHOLE_DOCUMENT || REPORT_CHAPTERS.some(item => item.title === title) ? title : WHOLE_DOCUMENT);

/**
 * The document at a clock time. `final` (reduced motion, or after the end) shows every note at once: issues with the
 * summary's stamp, debates with their replies, rulings, and the redline.
 */
export function deskAt(scenes: readonly Scene[], clock: number, final = false): DeskView {
  const shown = scenes.filter(scene => final || scene.start <= clock);
  const current = final ? null : shown[shown.length - 1] ?? null;
  const mode: Mode = final ? 'final' : current?.stage ?? 'seated';
  const local = current ? clock - current.start : 0;

  const decisions = new Map<string, Extract<MarginItem, { kind: 'decision' }>>();
  const issues: Extract<MarginItem, { kind: 'issue' }>[] = [];
  const splits = new Map<string, Extract<MarginItem, { kind: 'split' }>>();
  const rulings: Extract<MarginItem, { kind: 'ruling' }>[] = [];
  let redline: string[] = [];
  let revisionFailed = false;

  for (const scene of shown) {
    const live = scene === current;
    if (scene.kind === 'steelman') {
      const revealed = live ? scene.cards.filter((_, index) => local >= STEEL_ROW.lead + index * STEEL_ROW.gap).length : scene.cards.length;
      decisions.set(scene.decision, { kind: 'decision', key: `d-${scene.decision}`, decision: scene.decision, cards: scene.cards, open: live, revealed });
    }
    if (scene.kind === 'critique') {
      const upTo = live ? issueIndexAt(scene, clock) : scene.issues.length - 1;
      scene.issues.slice(0, upTo + 1).forEach((issue, index) => issues.push({
        kind: 'issue', key: issue.id, seat: scene.seat, issue, tone: live && index === upTo ? 'current' : 'normal', stamp: null,
      }));
    }
    if (scene.kind === 'divergence') {
      splits.set(scene.split.decision, { kind: 'split', key: scene.split.id, split: scene.split, cards: scene.cards, replies: [], current: live });
    }
    if (scene.kind === 'response') {
      const split = splits.get(scene.response.decision);
      split?.replies.push({ response: scene.response, verdictNow: scene.verdictNow, turned: !live || replyTurned(scene, clock), current: live });
    }
    if (scene.kind === 'ruling') rulings.push({ kind: 'ruling', key: scene.ruling.id, ruling: scene.ruling, current: live, compact: false });
    if (scene.kind === 'revision') {
      if (scene.result.type === 'revision_failed') revisionFailed = true;
      else {
        const titles = scene.result.changedSectionTitles;
        redline = live ? titles.filter((_, index) => local >= REDLINE.lead + index * REDLINE.gap) : titles;
      }
    }
  }
  if (current?.kind === 'response') for (const split of splits.values()) split.current = split.split.decision === current.response.decision;

  const stamped = (item: Extract<MarginItem, { kind: 'issue' }>) => {
    const match = rulings.find(entry => entry.ruling.section === item.issue.section && entry.ruling.reviewers.includes(item.seat));
    return match ? match.ruling.adopted : null;
  };
  const notes: Record<string, MarginItem[]> = {};
  const put = (title: string, item: MarginItem) => (notes[section(title)] ??= []).push(item);
  const collapsedDecisions = () => [...decisions.values()].map(item => ({ ...item, open: false }));

  switch (mode) {
    case 'steelman':
      for (const item of decisions.values()) put(DECISION_SECTION[item.decision], item);
      break;
    case 'critique':
      for (const item of collapsedDecisions()) put(DECISION_SECTION[item.decision], item);
      for (const item of issues) put(item.issue.section, item);
      break;
    case 'divergence':
      if (splits.size === 0) for (const item of collapsedDecisions()) put(DECISION_SECTION[item.decision], item);
      for (const item of issues) put(item.issue.section, { ...item, tone: 'quiet' });
      for (const item of splits.values()) put(DECISION_SECTION[item.split.decision], item);
      break;
    case 'debate':
      for (const item of issues) put(item.issue.section, { ...item, tone: 'quiet' });
      for (const item of splits.values()) put(DECISION_SECTION[item.split.decision], item);
      break;
    case 'ruling':
      for (const item of issues) put(item.issue.section, { ...item, tone: 'quiet', stamp: stamped(item) });
      for (const item of rulings) put(item.ruling.section, item);
      break;
    case 'revision':
      if (revisionFailed) for (const item of issues) put(item.issue.section, item);
      for (const item of rulings) put(item.ruling.section, { ...item, current: false, compact: true });
      break;
    case 'final':
      for (const item of collapsedDecisions()) if (!splits.has(item.decision)) put(DECISION_SECTION[item.decision], item);
      for (const item of issues) put(item.issue.section, { ...item, tone: 'quiet', stamp: stamped(item) });
      for (const item of splits.values()) put(DECISION_SECTION[item.split.decision], { ...item, current: false, compact: true });
      for (const item of rulings) put(item.ruling.section, { ...item, current: false, compact: true });
      break;
    default:
      break;
  }

  return { mode, focus: focusOf(current, clock), current: currentOf(current, clock), reading: readingOf(current, clock), notes, redline, revisionFailed };
}

function focusOf(scene: Scene | null, clock: number): string | null {
  switch (scene?.kind) {
    case 'steelman': return DECISION_SECTION[scene.decision];
    case 'critique': return scene.issues[Math.max(0, issueIndexAt(scene, clock))]?.section ?? null;
    case 'divergence': return DECISION_SECTION[scene.split.decision];
    case 'response': return DECISION_SECTION[scene.response.decision];
    case 'ruling': return section(scene.ruling.section);
    case 'revision': {
      if (scene.result.type !== 'revision_ready_for_choice') return null;
      // Follow the redline as it moves down the report: the latest chapter whose marks have appeared.
      const shown = scene.result.changedSectionTitles.filter((_, index) => clock - scene.start >= REDLINE.lead + index * REDLINE.gap);
      return shown.at(-1) ?? scene.result.changedSectionTitles[0] ?? null;
    }
    default: return null;
  }
}

function currentOf(scene: Scene | null, clock: number): string | null {
  switch (scene?.kind) {
    case 'steelman': return `d-${scene.decision}`;
    case 'critique': return scene.issues[issueIndexAt(scene, clock)]?.id ?? null;
    case 'divergence': return scene.split.id;
    case 'response': return scene.response.id;
    case 'ruling': return scene.ruling.id;
    default: return null;
  }
}

function readingOf(scene: Scene | null, clock: number): DeskView['reading'] {
  if (!scene) return {};
  const local = clock - scene.start;
  if (scene.kind === 'writing') return { S: chapterAt(local, 0) };
  if (scene.kind !== 'reading') return {};
  const reading: DeskView['reading'] = {};
  SEATS.forEach((seat, index) => {
    if (clock < (scene.submitAt[seat] ?? Infinity)) reading[seat] = chapterAt(local, index * 4 + (scene.round === 2 ? 1 : 0));
  });
  return reading;
}

export type SeatState = { text: string; tone: 'idle' | 'active' | 'done' | 'failed' };

/** One line per person on the panel strip: what they are doing now. */
export function seatStates(scene: Scene | null, clock: number, failed: readonly Seat[], ended: boolean): Record<SeatCode, SeatState> {
  const states = {} as Record<SeatCode, SeatState>;
  for (const seat of SEATS) {
    let state: SeatState = { text: '在席', tone: 'idle' };
    if (scene?.kind === 'reading') {
      const at = scene.submitAt[seat];
      state = at !== undefined && clock >= at ? { text: '已交卷', tone: 'done' } : { text: '审阅中', tone: 'active' };
    } else if (scene && scene.kind !== 'seated') state = { text: '已交卷', tone: 'done' };
    if (scene?.kind === 'critique' && scene.seat === seat) state = { text: '正在批注', tone: 'active' };
    if (scene?.kind === 'response' && scene.response.reviewer === seat) state = { text: '正在回复', tone: 'active' };
    if (failed.includes(seat)) state = { text: '没有给出可用意见', tone: 'failed' };
    states[seat] = state;
  }
  const summary: Partial<Record<Scene['kind'], SeatState>> = {
    writing: { text: '汇总中', tone: 'active' }, ruling: { text: '逐条裁决', tone: 'active' }, revision: { text: '已交修订稿', tone: 'done' },
  };
  states.S = ended ? { text: '已完成', tone: 'done' } : (scene && summary[scene.kind]) || { text: '等待汇总', tone: 'idle' };
  if (scene?.kind === 'revision' && scene.result.type === 'revision_failed') states.S = { text: '修订稿未通过检查', tone: 'failed' };
  return states;
}
