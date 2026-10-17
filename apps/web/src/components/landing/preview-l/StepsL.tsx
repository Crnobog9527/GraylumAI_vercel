/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronsDown } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { PositioningClipJ } from '@/components/landing/preview-j/PositioningClipJ';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { L_STEPS, type StepStage } from '@/lib/landing/landing-copy-l-steps';
import { allOn, visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { L_CLIP_PARTS } from './RealPartsL';
import styles from './steps-l.module.css';

/** How much of the scroll each stage takes: the two long conversations more, the plan's short summary less. */
const WEIGHT: Record<number, number> = { 0: 3, 1: 3, 2: 1.5, 3: 2.5 };
const SEEN_KEY = 'graylum-landing-l-step-one-seen';
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const readSeen = () => { try { return window.localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const writeSeen = () => { try { window.localStorage.setItem(SEEN_KEY, '1'); } catch { /* private window: not remembered */ } };

/** The stage at a point of the scroll (0 → 1), and how far into it. */
export function stageAt(stages: readonly StepStage[], progress: number) {
  const total = stages.reduce((sum, stage) => sum + (WEIGHT[stage.moment] ?? 2), 0);
  let from = 0;
  for (const [index, stage] of stages.entries()) {
    const to = from + (WEIGHT[stage.moment] ?? 2) / total;
    if (progress < to || index === stages.length - 1) {
      return { index, local: Math.min(1, Math.max(0, (progress - from) / (to - from))) };
    }
    from = to;
  }
  return { index: 0, local: 0 };
}

/**
 * Region 3, round four (Owner 2026-10-17): 第一步/第二步/第三步. Step one is sample J's whole positioning flow, the
 * real product's parts inside it (the question card, checklist, confirm area, research record, benchmark table and
 * report dialog; RealPartsL). The visitor watches it through: on screen the stage holds still and the scroll plays the
 * four stages, with the step's progress shown; a visitor who has seen it to the end before (remembered in this
 * browser) gets a button that jumps past it. Steps two and three show only once their capability ships. Server HTML
 * and reduced motion: the four stages stacked, finished.
 */
export function StepsL({ flags }: { flags: LandingFlags }) {
  const stages = visibleItems(flags, L_STEPS.one.stages);
  const ref = useRef<HTMLElement>(null);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState(0);
  const [seen, setSeen] = useState(false);

  useEffect(() => { setLocked(!reducedMotion()); setSeen(readSeen()); }, []);
  useEffect(() => {
    const node = ref.current;
    if (!locked || !node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const next = Math.round(Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height - window.innerHeight))) * 400) / 400;
      setProgress(next);
      if (next >= 0.98) writeSeen();
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, [locked]);

  const skip = () => {
    const node = ref.current;
    if (node) window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().bottom - 80, behavior: 'auto' });
  };
  const later = L_STEPS.later.filter(step => step.built && allOn(flags, step.needs));
  const { index, local } = stageAt(stages, progress);
  const stage = stages[index];

  return (
    <div id="how-it-works" data-zone="takeover" data-region="三步">
      {locked && stage ? (
        <section ref={ref} aria-labelledby="steps-title" className={cn(takeover.takeover, styles.story)}>
          <div className={cn(takeover.stage, styles.stage)}>
            <div className={cn(page.wrap, takeover.frame)}>
              <div className={takeover.head}>
                <h2 id="steps-title" className={takeover.title}>{L_STEPS.one.title}</h2>
                <div className={takeover.caption} aria-live="polite" key={stage.label}><h3>{stage.label}</h3><p>{stage.note}</p></div>
              </div>
              <div className={styles.progress}>
                <div className={takeover.bar} role="progressbar" aria-label={L_STEPS.progress} aria-valuenow={Math.round(progress * 100)}
                  aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${progress})` }} /></div>
                <ol className={styles.stages} aria-hidden="true">
                  {stages.map((item, order) => (
                    <li key={item.label} data-on={order === index || undefined} data-done={order < index || undefined}>{item.label}</li>
                  ))}
                </ol>
                {seen ? (
                  <button type="button" className={styles.skip} onClick={skip}><ChevronsDown size={15} aria-hidden="true" />{L_STEPS.skip}</button>
                ) : null}
              </div>
              <div className={takeover.picture}><PositioningClipJ moment={stage.moment} local={local} parts={L_CLIP_PARTS} /></div>
            </div>
          </div>
        </section>
      ) : (
        <section aria-labelledby="steps-title" className={cn(page.section, takeover.static)}>
          <div className={page.wrap}>
            <h2 id="steps-title" className={page.display}>{L_STEPS.one.title}</h2>
            {stages.map(item => (
              <article key={item.label} className={takeover.staticStep} data-region="第一步的阶段">
                <div className={takeover.caption}><h3>{item.label}</h3><p>{item.note}</p></div>
                <div className={takeover.picture}><PositioningClipJ moment={item.moment} local={1} parts={L_CLIP_PARTS} /></div>
              </article>
            ))}
          </div>
        </section>
      )}
      <div className={cn(k.wrap, styles.after)}><CtaK /></div>
      {later.map(step => (
        <section key={step.title} aria-label={step.title} className={k.section} data-region={step.title.slice(0, 3)}>
          <div className={k.wrap}>
            <h2 className={k.lead}>{step.title}</h2>
            <ol className={styles.later}>{step.items.map(item => <li key={item}>{item}</li>)}</ol>
            <CtaK />
          </div>
        </section>
      ))}
    </div>
  );
}
