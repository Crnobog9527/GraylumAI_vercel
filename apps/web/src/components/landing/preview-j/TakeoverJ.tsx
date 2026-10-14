/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { J_TAKEOVER } from '@/lib/landing/landing-copy-j';
import { J_JURY_PLACEHOLDER, J_TAKEOVER_SCENES } from '@/lib/landing/landing-copy-j-takeover';
import { cn } from '@/lib/utils';
import { PositioningClipJ } from './PositioningClipJ';
import styles from './takeover-j.module.css';
import page from './j.module.css';

/** Where each chapter starts and ends along the section's scroll, 0 → 1: the three positioning steps, then the jury. */
export const CHAPTERS = [
  { id: 'you', from: 0, to: 0.3 },
  { id: 'direction', from: 0.3, to: 0.52 },
  { id: 'benchmark', from: 0.52, to: 0.74 },
  { id: 'jury', from: 0.74, to: 1 },
] as const;
type ChapterId = (typeof CHAPTERS)[number]['id'];

/** The chapter at a point of the scroll, and how far into it (0 → 1). */
export function chapterAt(progress: number): { id: ChapterId; index: number; local: number } {
  const p = Math.min(1, Math.max(0, progress));
  const index = Math.max(0, CHAPTERS.findIndex(item => p < item.to));
  const at = p >= 1 ? CHAPTERS.length - 1 : index;
  const chapter = CHAPTERS[at];
  return { id: chapter.id, index: at, local: Math.min(1, (p - chapter.from) / (chapter.to - chapter.from)) };
}

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const SIDEBAR = [
  ...J_TAKEOVER_SCENES.map(scene => ({ id: scene.id as ChapterId, title: scene.title, note: scene.note })),
  { id: 'jury' as ChapterId, title: J_TAKEOVER.juryTitle, note: J_TAKEOVER.juryBody },
];

/**
 * "AI 教练怎么接手你的运营" (Owner 2026-10-15: sample H's layout, the real product, real expertise). Once the visitor
 * scrolls in, the stage holds still and the scroll plays the story: a sidebar of the scenes on the left (你是谁 →
 * 方向判断 → 找对标 → the jury; a click jumps there) with what the current one shows, and in the middle the real
 * positioning workbench — conversation and checklist — going through it. The pictures are not interactive (inert).
 * The server HTML, a visitor without JavaScript and one who asked for reduced motion get every scene stacked, finished.
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

  // The jury's new canvas version joins once #998 is merged and gives a 0 → 1 player with this case; until then a
  // placeholder holds its place (controller, 2026-10-15).
  const picture = (index: number, local: number): ReactNode => (index < 3
    ? <PositioningClipJ scene={index} local={local} />
    : <div className={styles.placeholder}><p>{J_JURY_PLACEHOLDER}</p></div>);

  if (!locked) {
    return (
      <section id="how-it-works" aria-labelledby="takeover-title" className={cn(page.section, styles.static)} data-zone="takeover">
        <div className={page.wrap}>
          <h2 id="takeover-title" className={page.display}>{HOW_IT_WORKS.title}</h2>
          {SIDEBAR.map((item, index) => (
            <article key={item.id} className={styles.staticStep}>
              <div className={styles.copy}><h3>{item.title}</h3><p>{item.note}</p></div>
              <div className={styles.picture} inert>{picture(index, 1)}</div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  const { index, local } = chapterAt(progress);
  const jump = (to: number) => {
    const node = ref.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top + window.scrollY;
    const span = node.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + span * (CHAPTERS[to].from + 0.01), behavior: 'smooth' });
  };
  return (
    <section ref={ref} id="how-it-works" aria-labelledby="takeover-title" className={styles.takeover} data-zone="takeover">
      <div className={styles.stage}>
        <div className={cn(page.wrap, styles.frame)}>
          <h2 id="takeover-title" className={styles.title}>{HOW_IT_WORKS.title}</h2>
          <div className={styles.body}>
            <nav className={styles.side} aria-label="场景">
              <ol>
                {SIDEBAR.map((item, at) => (
                  <li key={item.id} data-on={at === index || undefined} data-done={at < index || undefined}>
                    <button type="button" onClick={() => jump(at)} aria-current={at === index ? 'step' : undefined}>
                      <span className={styles.sideIndex} aria-hidden="true">{at + 1}</span><span className={styles.sideLabel}>{item.title}</span>
                    </button>
                    {at === index ? <p aria-live="polite">{item.note}</p> : null}
                  </li>
                ))}
              </ol>
              <div className={styles.bar} aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }} /></div>
            </nav>
            <div className={styles.picture} inert data-chapter={CHAPTERS[index].id}>{picture(index, local)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
