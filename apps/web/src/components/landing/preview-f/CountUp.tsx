/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';

// Amounts only: a year such as "2024 年" keeps its value.
const NUMBER = /\d[\d,]*(?![\d,]*\s*年)/g;

/** The text with every number scaled to `progress` (0–1), keeping thousands separators. Exported for tests. */
export function countTo(text: string, progress: number): string {
  return text.replace(NUMBER, match => {
    const value = Number(match.replace(/,/g, ''));
    const current = Math.round(value * progress);
    return match.includes(',') ? current.toLocaleString('en-US') : String(current);
  });
}

/**
 * Rolls the numbers in a price line up from zero once it scrolls into view. The server HTML and the end state are
 * the exact text; nothing moves without JavaScript or with reduced motion. Screen readers get the exact text only.
 */
export function CountUp({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const observer = new IntersectionObserver(entries => {
      // Still below the fold on the first report: start from zero so the roll-up is seen when it arrives.
      if (!entries.some(entry => entry.isIntersecting)) { setShown(countTo(text, 0)); return; }
      observer.disconnect();
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / 1100);
        setShown(countTo(text, 1 - Math.pow(1 - t, 3)));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, { rootMargin: '0px 0px -15% 0px' });
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [text]);

  return (
    <span ref={ref}>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
