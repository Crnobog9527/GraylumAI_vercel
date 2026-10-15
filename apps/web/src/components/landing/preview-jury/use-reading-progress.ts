/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';

/** How far down an element the reader has scrolled, 0 to 1: its bottom edge reaching the bottom of the window is 1. */
export function useReadingProgress(id: string): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const node = document.getElementById(id);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const read = window.innerHeight - rect.top;
      setProgress(Math.min(1, Math.max(0, read / Math.max(1, rect.height))));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [id]);
  return progress;
}
