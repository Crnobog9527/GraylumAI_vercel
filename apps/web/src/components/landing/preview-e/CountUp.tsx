/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';

const DURATION = 900;
const NUMBER = /^(\D*)(\d[\d,]*)(\.\d+)?(.*)$/;

/**
 * A price such as "$29" that counts up from 0 the first time it scrolls into view (ploy's number roll).
 * The server HTML and screen readers always have the final text; reduced motion and text without a number
 * show the final text directly.
 */
export function CountUp({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useEffect(() => {
    const node = ref.current;
    const match = text.match(NUMBER);
    setShown(text);
    if (!node || !match || match[3] || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const [, prefix, digits, , suffix] = match;
    const target = Number(digits.replace(/,/g, ''));
    let frame = 0;
    setShown(`${prefix}0${suffix}`);
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      const begin = performance.now();
      const tick = (now: number) => {
        const progress = Math.min((now - begin) / DURATION, 1);
        const eased = 1 - (1 - progress) ** 3;
        setShown(`${prefix}${Math.round(target * eased).toLocaleString('en-US')}${suffix}`);
        if (progress < 1) frame = requestAnimationFrame(tick);
        else setShown(text);
      };
      frame = requestAnimationFrame(tick);
    }, { rootMargin: '0px 0px -10% 0px' });
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [text]);

  return (
    <b ref={ref}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </b>
  );
}
