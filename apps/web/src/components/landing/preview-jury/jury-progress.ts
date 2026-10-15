/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SEATS, type JuryEvent, type Seat, type SeatCode } from './jury-events';
import type { Arrived } from './JuryDossier';
import type { Scene } from './jury-scenes';
import type { MockArrival } from './jury-scripts';

/** Small read-outs of the playback for the room and the records. */

/** Which parts of the full record exist at a clock time: a seat's round once its answer arrived, the summary's output. */
export function arrivedAt(arrivals: readonly MockArrival[], clock: number): Arrived {
  const events: JuryEvent[] = arrivals.filter(arrival => arrival.atMs <= clock).flatMap(arrival => arrival.events);
  const rounds = Object.fromEntries(SEATS.map(seat => [seat, [] as number[]])) as Record<Seat, number[]>;
  for (const event of events) {
    if (event.type === 'reviewer_started' || !('reviewer' in event) || !('round' in event)) continue;
    if (!rounds[event.reviewer].includes(event.round)) rounds[event.reviewer].push(event.round);
  }
  const summary = events.some(event => ['adjudication', 'revision_ready_for_choice', 'revision_failed'].includes(event.type));
  return { rounds, summary };
}

/** Reviewers whose failure the stage has already shown; they stay greyed out from then on. */
export function failedSeatsAt(scenes: readonly Scene[], clock: number): Seat[] {
  const failed = new Set<Seat>();
  for (const scene of scenes) {
    if (scene.kind === 'failed' && scene.start <= clock) failed.add(scene.failure.reviewer);
    if (scene.kind === 'reading' && scene.start <= clock) {
      for (const seat of scene.failed) if ((scene.submitAt[seat] ?? Infinity) <= clock) failed.add(seat);
    }
  }
  return [...failed];
}

/** Whose record to show when the user is not pointing at anyone: whoever the stage is about. */
export function speakerOf(scene: Scene | null): SeatCode | null {
  switch (scene?.kind) {
    case 'critique': return scene.seat;
    case 'response': return scene.response.reviewer;
    case 'failed': return scene.failure.reviewer;
    case 'writing': case 'ruling': case 'revision': return 'S';
    default: return null;
  }
}
