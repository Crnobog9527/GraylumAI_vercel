/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True when the visitor asked for less motion; false on the server and before hydration. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(REDUCED).matches, () => false);
}

/**
 * The playback clock: real time × speed, stopping at the end. It ticks ten times a second (CSS carries the
 * motion) and keeps running in a background tab, as the real review would; a long gap (a throttled tab) is capped at five seconds.
 */
export function useJuryPlayback(lengthMs: number, enabled: boolean) {
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const last = useRef<number | null>(null);
  const finished = clock >= lengthMs;

  // The timer only lives while playing and before the end, so a finished replay leaves nothing running.
  useEffect(() => {
    if (!enabled || !playing || finished) return;
    last.current = performance.now();
    const timer = window.setInterval(() => {
      const time = performance.now();
      const delta = Math.min(time - (last.current ?? time), 5000);
      last.current = time;
      setClock(value => Math.min(lengthMs, value + delta * speed));
    }, 100);
    return () => {
      window.clearInterval(timer);
      last.current = null;
    };
  }, [enabled, playing, finished, speed, lengthMs]);

  const restart = useCallback(() => {
    setClock(0);
    setPlaying(true);
  }, []);
  const toggle = useCallback(() => {
    if (finished) restart();
    else setPlaying(value => !value);
  }, [finished, restart]);

  return { clock, playing: playing && !finished, finished, speed, setSpeed, toggle, restart };
}
