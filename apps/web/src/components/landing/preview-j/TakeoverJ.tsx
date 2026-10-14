/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { J_TAKEOVER_MOMENTS } from '@/lib/landing/landing-copy-j-takeover';
import { cn } from '@/lib/utils';
import { PositioningClipJ } from './PositioningClipJ';
import styles from './takeover-j.module.css';
import page from './j.module.css';

/** Where each moment starts and ends along the section's scroll, 0 → 1: three steps, the report, then the jury. */
export const CHAPTERS = [
  { id: 'know', from: 0, to: 0.2 },
  { id: 'diagnose', from: 0.2, to: 0.38 },
  { id: 'plan', from: 0.38, to: 0.5 },
  { id: 'report', from: 0.5, to: 0.64 },
  { id: 'jury', from: 0.64, to: 1 },
] as const;
type ChapterId = (typeof CHAPTERS)[number]['id'];

/** The moment at a point of the scroll, and how far into it (0 → 1). */
export function chapterAt(progress: number): { id: ChapterId; index: number; local: number } {
  const p = Math.min(1, Math.max(0, progress));
  const found = CHAPTERS.findIndex(item => p < item.to);
  const index = found < 0 ? CHAPTERS.length - 1 : found;
  const chapter = CHAPTERS[index];
  return { id: chapter.id, index, local: Math.min(1, (p - chapter.from) / (chapter.to - chapter.from)) };
}

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * "AI 教练怎么接手你的运营" (Owner 2026-10-15, round four): the real product's positioning workspace, nothing invented
 * around it. Its own step strip is the only step list; what the current moment shows is said above the window. Once
 * the visitor scrolls in, the stage holds still and the scroll plays: 你是谁 (shown as "帮你挖掘定位"), 方向判断, 找对标,
 * then the long report from the workbench footer, then the jury opened from the report. The window is a picture
 * (inert). The server HTML, no JavaScript and reduced motion get every moment stacked, finished. `intro` (the sample
 * reports) sits under the title.
 */
export function TakeoverJ({ intro }: { intro?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setLocked(!reducedMotion());
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!locked || !node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const span = Math.max(1, rect.height - window.innerHeight);
      // Quantised, so the window re-renders a few hundred times per pass at most.
      setProgress(Math.round(Math.min(1, Math.max(0, -rect.top / span)) * 400) / 400);
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
  }, [locked]);

  if (!locked) {
    return (
      <section id="how-it-works" aria-labelledby="takeover-title" className={cn(page.section, styles.static)} data-zone="takeover">
        <div className={page.wrap}>
          <h2 id="takeover-title" className={page.display}>{HOW_IT_WORKS.title}</h2>
          {intro}
          {J_TAKEOVER_MOMENTS.map((moment, index) => (
            <article key={moment.id} className={styles.staticStep}>
              <div className={styles.caption}><h3>{moment.caption}</h3><p>{moment.note}</p></div>
              <div className={styles.picture} inert><PositioningClipJ moment={index} local={1} /></div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  const { index, local } = chapterAt(progress);
  const moment = J_TAKEOVER_MOMENTS[index];
  return (
    <div className={styles.outer} data-zone="takeover">
      {intro ? <div className={cn(page.wrap, styles.intro)}>{intro}</div> : null}
      <section ref={ref} id="how-it-works" aria-labelledby="takeover-title" className={styles.takeover}>
        <div className={styles.stage}>
          <div className={cn(page.wrap, styles.frame)}>
            <div className={styles.head}>
              <h2 id="takeover-title" className={styles.title}>{HOW_IT_WORKS.title}</h2>
              <div className={styles.caption} aria-live="polite" key={moment.id}>
                <h3>{moment.caption}</h3>
                <p>{moment.note}</p>
              </div>
            </div>
            <div className={styles.bar} aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }} /></div>
            <div className={styles.picture} inert data-chapter={moment.id}><PositioningClipJ moment={index} local={local} /></div>
          </div>
        </div>
      </section>
    </div>
  );
}
