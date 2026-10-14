/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Scene } from './jury-scenes';

/** How long each kept scene plays in the brief version, at 1×. */
const BRIEF_LENGTH: Partial<Record<Scene['kind'], number>> = {
  seated: 2500, reading: 3500, steelman: 4000, divergence: 4500, agreed: 3000, response: 4500, failed: 3000,
  writing: 3000, ruling: 3200, revision: 5000,
};
const BRIEF_RULINGS = 3;

/**
 * A shorter replay of the same review for places like the landing page: one key decision instead of four, each
 * reviewer's critique cut to its first issue, the first split and the first reply only, three rulings. Every stage
 * that happened is still shown, in the same order, played back to back from zero. It replays a finished review, so
 * it ignores arrival times; the real review page always plays the full plan.
 */
export function briefScenes(scenes: readonly Scene[]): Scene[] {
  const kept = scenes.filter((scene, index) => {
    const before = scenes.slice(0, index);
    switch (scene.kind) {
      case 'steelman': return scene.index === 0;
      case 'divergence': return scene.index === 0;
      case 'response': return !before.some(item => item.kind === 'response');
      case 'ruling': return scene.index < BRIEF_RULINGS;
      default: return true;
    }
  });
  let cursor = 0;
  return kept.map(scene => {
    const brief: Scene = scene.kind === 'critique' ? { ...scene, issues: scene.issues.slice(0, 1) }
      : scene.kind === 'ruling' ? { ...scene, total: Math.min(scene.total, BRIEF_RULINGS) } : scene;
    const length = scene.kind === 'critique' ? 4500 : BRIEF_LENGTH[scene.kind] ?? scene.end - scene.start;
    const start = cursor;
    cursor += length;
    if (brief.kind === 'reading') {
      // Submissions land inside the shorter wait, one after another.
      const submitAt = Object.fromEntries(Object.keys(brief.submitAt).map((seat, order) => [seat, start + 1200 + order * 600]));
      return { ...brief, submitAt, start, end: cursor };
    }
    return { ...brief, start, end: cursor };
  });
}
