/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';

/** A number in the text, unless it is a year ("2024 年"). */
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

type Part = { text: string; value?: number; decimals?: number; commas?: boolean };

function parts(text: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const match of text.matchAll(NUMBER)) {
    const at = match.index ?? 0;
    const token = match[0];
    const isYear = /^\s?年/.test(text.slice(at + token.length));
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push(isYear ? { text: token } : {
      text: token, value: Number(token.replace(/,/g, '')), decimals: token.split('.')[1]?.length ?? 0, commas: token.includes(','),
    });
    last = at + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const format = (part: Part, value: number) => {
  const fixed = value.toFixed(part.decimals ?? 0);
  return part.commas ? Number(fixed).toLocaleString('en-US', { minimumFractionDigits: part.decimals ?? 0 }) : fixed;
};

/**
 * Text whose numbers "add up" once `play` turns on: each runs from 0 to its value (years stay as they are). The server
 * HTML and reduced motion show the final text; until `play`, a page with motion shows the numbers at 0.
 */
export function CountUpJ({ text, play, delay = 0, duration = 1100 }: { text: string; play: boolean; delay?: number; duration?: number }) {
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    if (!play) { setProgress(0); return; }
    let frame = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setProgress(1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [play, delay, duration]);
  if (progress === null || progress >= 1) return <>{text}</>;
  return <>{parts(text).map(part => (part.value === undefined ? part.text : format(part, part.value * progress))).join('')}</>;
}
