/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * How far down an element the reader has scrolled, 0 to 1: its bottom edge reaching the bottom of the window is 1.
 * With `root` (a scrolling box the page sits in, e.g. the landing page's frame), measured against that box instead.
 */
export function useReadingProgress(id: string, root?: RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const node = document.getElementById(id);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const box = root?.current?.getBoundingClientRect();
      const read = (box ? box.bottom : window.innerHeight) - rect.top;
      setProgress(Math.min(1, Math.max(0, read / Math.max(1, rect.height))));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const target: HTMLElement | Window = root?.current ?? window;
    measure();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [id, root]);
  return progress;
}
