/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState, type RefObject } from 'react';
import { LOOP_HOLD_MS, loopState } from '@/lib/landing/loop-timeline';

/** The picture is redrawn at most this often (milliseconds): typing reads smoothly, the page stays light. */
const FRAME_MS = 1000 / 30;
/** A frame that took longer than this (a busy page, a sleeping laptop) counts as this long, so nothing is skipped. */
const LONGEST_FRAME_MS = 100;

export type LoopAt = {
  /** Milliseconds into the current round; `null` is the finished picture. */
  ms: number | null;
  /** Rounds played so far. */
  round: number;
};

/**
 * A module's own clock (Owner 2026-11-11: the modules play by themselves, in a loop; the page scrolls freely past them).
 * It runs only while `ref` is on screen and the tab is showing; off screen it stops where it is and goes on from there.
 * Server HTML, reduced motion and browsers without IntersectionObserver get `null`: the finished picture, still.
 * `data-loop` on the node says which ("playing", "paused", "still"), for the browser checks.
 */
export function useLoop(ref: RefObject<HTMLElement | null>, totalMs: number): LoopAt {
  const [at, setAt] = useState<LoopAt>({ ms: null, round: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node || totalMs <= 0 || typeof IntersectionObserver === 'undefined' || !window.matchMedia) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const playMs = Math.max(0, totalMs - LOOP_HOLD_MS);
    let elapsed = 0;
    let last = 0;
    let drawn: LoopAt = { ms: null, round: 0 };
    let frame = 0;
    let seen = false;
    // Where the clock is: during the hold at the end of a round the picture is finished and is not drawn again.
    const now = () => ({ ms: Math.min(elapsed % totalMs, playMs), round: Math.floor(elapsed / totalMs) });
    const draw = () => {
      const next = now();
      const due = drawn.ms === null || next.round !== drawn.round || next.ms === playMs || next.ms - drawn.ms >= FRAME_MS;
      if (!due || (next.ms === drawn.ms && next.round === drawn.round)) return;
      drawn = next;
      setAt(next);
    };
    const tick = (time: number) => {
      elapsed += Math.min(LONGEST_FRAME_MS, Math.max(0, time - last));
      last = time;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      const state = loopState({ seen, tabShowing: document.visibilityState === 'visible', reducedMotion: still.matches });
      if (state === 'playing' && !frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
      if (state !== 'playing' && frame) { cancelAnimationFrame(frame); frame = 0; }
      node.dataset.loop = state;
      if (state === 'still') { drawn = { ms: null, round: drawn.round }; setAt(shown => (shown.ms === null ? shown : drawn)); }
      // Waiting off screen before its first round, it shows that round's first frame (never seen: it is off screen).
      else if (state === 'paused') draw();
    };
    const observer = new IntersectionObserver(entries => {
      seen = entries[entries.length - 1]?.isIntersecting ?? false;
      sync();
    }, { threshold: 0.25 });
    observer.observe(node);
    sync();
    document.addEventListener('visibilitychange', sync);
    still.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      still.removeEventListener('change', sync);
      cancelAnimationFrame(frame);
      delete node.dataset.loop;
    };
  }, [ref, totalMs]);
  return at;
}
