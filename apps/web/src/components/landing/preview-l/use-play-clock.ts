/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';

/** How often the clock tells the page (milliseconds): about once per typed character. */
const STEP_MS = 25;

/**
 * A play clock (round seven, T2): while `running`, it counts up frame by frame (requestAnimationFrame) at `rate()`
 * times real time, up to `limit`, and stays where it is while stopped.
 */
export function usePlayClock(running: boolean, limit: number, rate: () => number) {
  const [ms, setMs] = useState(0);
  const value = useRef(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = performance.now();
    let told = value.current;
    const tick = (now: number) => {
      value.current = Math.min(limit, value.current + Math.min(100, now - last) * rateRef.current());
      last = now;
      if (value.current - told >= STEP_MS || value.current >= limit) { told = value.current; setMs(value.current); }
      if (value.current < limit) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, limit]);
  return ms;
}
