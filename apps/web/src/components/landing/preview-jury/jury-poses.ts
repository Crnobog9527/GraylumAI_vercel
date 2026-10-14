/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SEATS, type Seat } from './jury-events';
import { BEAT, type Scene } from './jury-scenes';

/**
 * What each character is doing at a clock time, derived from the scene on stage. Poses are pure labels; the room's
 * CSS turns them into motion. Reviewers never "think" on stage after their answer arrived, and never speak before.
 */
export type ReviewerPose = 'idle' | 'reading' | 'thinking' | 'submitted' | 'speaking' | 'listening' | 'objecting' | 'nodding' | 'absent';
export type JudgePose = 'idle' | 'watching' | 'writing' | 'gavel' | 'presenting' | 'failed';
/** Which way a reviewer leans: toward the other side of a split, or toward the one they answer. */
export type Facing = 'left' | 'right';
export type Poses = {
  seats: Record<Seat, ReviewerPose>; judge: JudgePose; bubble: Partial<Record<Seat | 'S', string>>; face: Partial<Record<Seat, Facing>>;
};

const toward = (from: Seat, others: readonly Seat[]): Facing | undefined => {
  const here = SEATS.indexOf(from);
  const mean = others.reduce((sum, seat) => sum + SEATS.indexOf(seat), 0) / Math.max(1, others.length);
  return others.length === 0 || mean === here ? undefined : mean < here ? 'left' : 'right';
};

const all = (pose: ReviewerPose): Record<Seat, ReviewerPose> => ({ A: pose, B: pose, C: pose });

/** Which issue of a critique scene is on the table now (−1 before the first one flies out). */
export function issueIndexAt(scene: Extract<Scene, { kind: 'critique' }>, clock: number): number {
  const elapsed = clock - scene.start - BEAT.issueLead;
  return elapsed < 0 ? -1 : Math.min(scene.issues.length - 1, Math.floor(elapsed / BEAT.issue));
}

/** A speaker states the other side first, then shows where they now stand. */
export const responseTurned = (scene: Scene, clock: number) => clock - scene.start > BEAT.response * 0.45;

export function posesAt(scene: Scene | null, clock: number, failed: readonly Seat[]): Poses {
  const seats = all('idle');
  const bubble: Poses['bubble'] = {};
  const face: Poses['face'] = {};
  let judge: JudgePose = 'idle';
  const local = scene ? clock - scene.start : 0;
  switch (scene?.kind) {
    case 'reading':
      SEATS.forEach((seat, index) => {
        const at = scene.submitAt[seat];
        if (scene.failed.includes(seat) && at !== undefined && clock >= at) seats[seat] = 'absent';
        else if (at !== undefined && clock >= at) { seats[seat] = 'submitted'; bubble[seat] = '交卷'; }
        else seats[seat] = Math.floor(local / 2800 + index * 0.6) % 2 === 0 ? 'reading' : 'thinking';
      });
      judge = 'watching';
      break;
    case 'steelman':
      SEATS.forEach((seat, index) => {
        const card = scene.cards.find(item => item.seat === seat);
        if (!card || local < 900 + index * 650) return;
        seats[seat] = card.verdict === 'change' ? 'objecting' : 'nodding';
        bubble[seat] = card.verdict === 'change' ? '要改' : '保留';
      });
      break;
    case 'critique':
      SEATS.forEach(seat => { seats[seat] = seat === scene.seat ? 'speaking' : 'listening'; });
      judge = 'watching';
      break;
    case 'divergence':
      for (const seat of scene.split.change) { seats[seat] = 'objecting'; bubble[seat] = '要改'; }
      for (const seat of scene.split.keep) { seats[seat] = 'speaking'; bubble[seat] = '保留'; }
      for (const seat of scene.split.change) face[seat] = toward(seat, scene.split.keep);
      for (const seat of scene.split.keep) face[seat] = toward(seat, scene.split.change);
      judge = 'watching';
      break;
    case 'agreed':
      Object.assign(seats, all('nodding'));
      break;
    case 'response': {
      const { reviewer, to, stance } = scene.response;
      seats[to] = 'listening';
      const turned = responseTurned(scene, clock);
      seats[reviewer] = !turned ? 'speaking' : stance === 'agree' ? 'nodding' : 'objecting';
      if (turned) bubble[reviewer] = stance === 'agree' ? '有道理' : '我不同意';
      face[reviewer] = toward(reviewer, [to]);
      face[to] = toward(to, [reviewer]);
      break;
    }
    case 'failed':
      seats[scene.failure.reviewer] = 'absent';
      break;
    case 'writing':
      judge = 'writing';
      break;
    case 'ruling':
      judge = 'gavel';
      bubble.S = scene.ruling.adopted ? '采纳' : '不采纳';
      for (const seat of scene.ruling.reviewers) seats[seat] = 'listening';
      break;
    case 'revision':
      judge = scene.result.type === 'revision_failed' ? 'failed' : 'presenting';
      break;
    default:
      break;
  }
  for (const seat of failed) if (seats[seat] === 'idle' || seats[seat] === 'listening') seats[seat] = 'absent';
  return { seats, judge, bubble, face };
}
