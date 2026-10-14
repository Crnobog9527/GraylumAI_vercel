/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { J_TAKEOVER } from '@/lib/landing/landing-copy-j';
import { cn } from '@/lib/utils';
import { JuryClipJ } from './JuryClipJ';
import { PositioningClipJ } from './PositioningClipJ';
import { PromiseClipJ } from './PromiseClipJ';
import styles from './takeover-j.module.css';
import page from './j.module.css';

/** Where each chapter starts and ends along the section's scroll, 0 → 1. */
export const CHAPTERS = [
  { id: 'positioning', from: 0, to: 0.46 },
  { id: 'jury', from: 0.46, to: 0.74 },
  { id: 'promises', from: 0.74, to: 1 },
] as const;
type ChapterId = (typeof CHAPTERS)[number]['id'];

/** The chapter at a point of the scroll, and how far into it (0 → 1). */
export function chapterAt(progress: number): { id: ChapterId; local: number } {
  const p = Math.min(1, Math.max(0, progress));
  const chapter = CHAPTERS.find(item => p < item.to) ?? CHAPTERS[CHAPTERS.length - 1];
  return { id: chapter.id, local: Math.min(1, (p - chapter.from) / (chapter.to - chapter.from)) };
}

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * "AI 教练怎么接手你的运营" as a scroll-locked story. Once the visitor scrolls in, the stage holds still and the
 * scroll only advances the animation: the free positioning analysis (你是谁 → 方向判断 → 找对标), then the review
 * panel on a finished report, then what you no longer do yourself; when it has played through, the page scrolls on.
 * The pictures are not interactive (inert) and play quickly. The server HTML, a visitor without JavaScript and one
 * who asked for reduced motion all get the same story as static steps, with nothing locked.
 */
export function TakeoverJ() {
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
      // Quantised, so the clips re-render a few hundred times per pass at most.
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

  const { id, local } = chapterAt(progress);
  const chapters: { id: ChapterId; title: string; body: ReactNode; picture: ReactNode }[] = [
    { id: 'positioning', title: J_TAKEOVER.positioningTitle, body: J_TAKEOVER.positioningBody,
      picture: <PositioningClipJ progress={locked ? (id === 'positioning' ? local : 1) : 1} /> },
    { id: 'jury', title: J_TAKEOVER.juryTitle, body: J_TAKEOVER.juryBody,
      picture: <JuryClipJ progress={locked ? (id === 'jury' ? local : id === 'positioning' ? 0 : 1) : 0.62} /> },
    { id: 'promises', title: J_TAKEOVER.promisesTitle, body: J_TAKEOVER.promiseClose,
      picture: <PromiseClipJ progress={locked ? (id === 'promises' ? local : 0) : 1} /> },
  ];

  if (!locked) {
    return (
      <section id="how-it-works" aria-labelledby="takeover-title" className={cn(page.section, styles.static)} data-zone="takeover">
        <div className={page.wrap}>
          <h2 id="takeover-title" className={page.display}>{HOW_IT_WORKS.title}</h2>
          {chapters.map(chapter => (
            <article key={chapter.id} className={styles.staticStep}>
              <div className={styles.copy}><h3>{chapter.title}</h3><p>{chapter.body}</p></div>
              <div className={styles.picture} inert>{chapter.picture}</div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  const current = chapters.find(chapter => chapter.id === id) ?? chapters[0];
  return (
    <section ref={ref} id="how-it-works" aria-labelledby="takeover-title" className={styles.takeover} data-zone="takeover">
      <div className={styles.stage}>
        <div className={cn(page.wrap, styles.frame)}>
          <header className={styles.head}>
            <h2 id="takeover-title" className={styles.title}>{HOW_IT_WORKS.title}</h2>
            <ol className={styles.steps} aria-hidden="true">
              {chapters.map(chapter => <li key={chapter.id} data-on={chapter.id === id || undefined}>{chapter.title}</li>)}
            </ol>
          </header>
          <div className={styles.body}>
            <div className={styles.copy} aria-live="polite" key={current.id}>
              <h3>{current.title}</h3>
              <p>{current.body}</p>
            </div>
            <div className={styles.picture} inert data-chapter={current.id}>{current.picture}</div>
          </div>
          <div className={styles.bar} aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }} /></div>
        </div>
      </div>
    </section>
  );
}
