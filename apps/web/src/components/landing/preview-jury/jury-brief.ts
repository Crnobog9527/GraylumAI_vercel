/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Scene } from './jury-scenes';

/** How long each key moment plays in the short version, at 1×. */
const BRIEF_LENGTH: Partial<Record<Scene['kind'], number>> = {
  seated: 2500, reading: 4500, divergence: 4500, agreed: 3500, writing: 3500, ruling: 3200, revision: 5000,
};
const BRIEF_RULINGS = 3;

/**
 * The short version for the landing page: only the key moments play — seated, reading, the first disagreement (or
 * the agreement), the summary with its first three rulings shown, and the new report. Everything else (the key-decision
 * cards, the critiques, the second round) still happens, but silently in no time at the end of the reading, so the
 * result cards and counts stay true. Played back to back from zero; it replays a finished review, so arrival times
 * are ignored. The real review page always plays the full plan.
 */
export function briefScenes(scenes: readonly Scene[]): Scene[] {
  let cursor = 0;
  let splits = 0;
  const out: Scene[] = [];
  for (const scene of scenes) {
    let length = BRIEF_LENGTH[scene.kind] ?? 0;
    // Only the first reading round and the first split are shown; later ones play silently.
    if (scene.kind === 'reading' && scene.round === 2) length = 0;
    if (scene.kind === 'divergence' && splits++ > 0) length = 0;
    // Rulings after the first three are counted but not shown, so the summary's tally stays true.
    if (scene.kind === 'ruling' && scene.index >= BRIEF_RULINGS) length = 0;
    const start = cursor;
    cursor += length;
    const moved = { ...scene, start, end: cursor } as Scene;
    if (moved.kind === 'reading') {
      // Submissions land inside the shorter wait, one after another; a silent round has handed in already.
      moved.submitAt = Object.fromEntries(Object.keys(moved.submitAt)
        .map((seat, order) => [seat, length > 0 ? start + 1500 + order * 700 : start]));
    }
    out.push(moved);
  }
  return out;
}
