/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, type RefObject } from 'react';

/** The four parts of a sample S page, in order: first screen, step one, the jury, the footer. */
const PARTS = ['[data-region="首屏"]', '[aria-labelledby="step-one-title"]', '[data-region="评审团"]', '[data-region="页脚"]'];

/**
 * Where the reader is on a sample S page, as CSS variables on the page root (the art layer's parent), so the backdrop
 * can follow the scroll continuously rather than switching at a line: `--s-t` runs 0 (first screen) → 1 (step one,
 * held through its whole scroll track) → 2 (the jury) → 3 (the footer), and `--w0`…`--w3` weigh each part (1 at its
 * own point, fading linearly to 0 at its neighbours; they always add up to 1). Colour only, so reduced motion keeps it.
 */
export function useZoneWeights(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const [hero, one, jury, foot] = PARTS.map(selector => root.querySelector<HTMLElement>(selector));
      if (!hero || !one || !jury || !foot) return;
      const view = window.innerHeight;
      const top = (node: HTMLElement) => node.getBoundingClientRect().top + window.scrollY;
      const last = document.documentElement.scrollHeight - view / 2;
      const marks: [number, number][] = [
        [top(hero) + hero.offsetHeight / 2, 0],
        [top(one) + view / 2, 1],
        [top(one) + one.offsetHeight - view / 2, 1],
        [top(jury) + jury.offsetHeight / 2, 2],
        [Math.min(last, top(foot) + foot.offsetHeight / 2), 3],
      ];
      for (let i = 1; i < marks.length; i += 1) marks[i]![0] = Math.max(marks[i]![0], marks[i - 1]![0] + 1);
      const y = window.scrollY + view / 2;
      let t = y <= marks[0]![0] ? 0 : 3;
      for (let i = 1; i < marks.length; i += 1) {
        const [y0, t0] = marks[i - 1]!;
        const [y1, t1] = marks[i]!;
        if (y < y1) { t = y <= y0 ? t0 : t0 + ((y - y0) / (y1 - y0)) * (t1 - t0); break; }
      }
      root.style.setProperty('--s-t', t.toFixed(4));
      for (let part = 0; part < 4; part += 1) root.style.setProperty(`--w${part}`, Math.max(0, 1 - Math.abs(t - part)).toFixed(4));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, [ref]);
}
