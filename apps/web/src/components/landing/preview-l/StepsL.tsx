/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDown } from 'lucide-react';
import { AsDemo } from '@/components/chat-display/display-heading';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { momentAt, momentMs, ONE_MS, stagesAt } from '@/lib/landing/step-one-timeline';
import { cn } from '@/lib/utils';
import { DemoTag } from './DemoTag';
import { LaterStepsL } from './LaterStepsL';
import { PositioningPictureL, stepOneScript } from './PositioningPictureL';
import styles from './steps-l.module.css';

/** How much of the step's clock one pixel of scrolling moves (milliseconds): a notch of the wheel types a sentence or two. */
const MS_PER_PX = 25;
const SEEN_KEY = 'graylum-landing-l-step-one-seen';
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const readSeen = () => { try { return window.localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const writeSeen = () => { try { window.localStorage.setItem(SEEN_KEY, '1'); } catch { /* private window: not remembered */ } };

/**
 * Region 3 (Owner 2026-10-17): 第一步/第二步/第三步. Step one is the whole positioning flow on the real product's display
 * components (PositioningPictureL). Round eight (U1, Owner 2026-10-18: "通过用户自己滚动鼠标来控制这个进度……这一次，
 * 用户滚动鼠标控制的是现在流式输入输出的展现效果"): the stage holds still while the page scrolls through its track, and
 * the scroll is the step's clock (step-one-timeline.ts): scrolling down types it on, character by character, scrolling
 * up takes it back; the track is long enough that the visitor goes through all four stages, the report opening last,
 * before the page goes on to step two. Scrolling inside the conversation only reads it. A visitor who has seen it
 * before (remembered in this browser) gets a button that jumps past it. Server HTML and reduced motion: the four
 * stages stacked, finished.
 */
export function StepsL({ flags }: { flags: LandingFlags }) {
  const stages = visibleItems(flags, L_STEPS.one.stages);
  const durations = useMemo(() => stages.map(stage => (stage.moment === 3 ? ONE_MS.report : momentMs(stepOneScript(stage.moment)))), [stages]);
  const total = durations.reduce((sum, length) => sum + length, 0);
  const ref = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(false);
  const [seen, setSeen] = useState(false);
  const [ms, setMs] = useState(0);

  useEffect(() => { setLocked(!reducedMotion()); setSeen(readSeen()); }, []);
  useEffect(() => {
    const node = ref.current;
    if (!locked || !node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const run = Math.max(1, rect.height - window.innerHeight);
      setMs(Math.min(1, Math.max(0, -rect.top / run)) * total);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, [locked, total]);

  const skip = () => {
    const node = ref.current;
    if (node) window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().bottom - 80, behavior: 'auto' });
  };
  const { index, ms: inStage } = stagesAt(durations, ms);
  const stage = stages[index];
  const at = stage && stage.moment < 3 ? momentAt(stepOneScript(stage.moment), inStage) : null;
  const progress = total ? ms / total : 0;
  // Owner 2026-10-17, round five: the step counts as watched once the report dialog opens; from then on it can be skipped.
  const reportOpen = locked && stage?.moment === 3;
  useEffect(() => { if (reportOpen) { writeSeen(); setSeen(true); } }, [reportOpen]);

  return (
    <section id="how-it-works" aria-labelledby="steps-title" data-zone="takeover" data-region="三步">
      <div className={cn(k.wrap, styles.intro)}><h2 id="steps-title" className={k.lead}>{HOW_IT_WORKS.title}</h2></div>
      {locked && stage ? (
        <div ref={ref} role="group" aria-labelledby="step-one-title" className={cn(takeover.takeover, styles.story)}
          style={{ height: `calc(100svh + ${Math.round(total / MS_PER_PX)}px)` }}>
          <div className={cn(takeover.stage, styles.stage)}>
            <div className={cn(page.wrap, takeover.frame, styles.oneFrame)}>
              {/* Round seven (T1): the step's title on a line of its own; under it the progress and the stage names; then
                  the current stage's name and note, just above the picture. */}
              <h3 id="step-one-title" className={cn(takeover.title, styles.oneTitle)}>{L_STEPS.one.title}</h3>
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
              <div className={cn(takeover.caption, styles.oneCaption)} aria-live="polite" key={stage.label}>
                <h3>{stage.label}<DemoTag /></h3><p>{stage.note}</p>
              </div>
              <div className={takeover.picture}><AsDemo><PositioningPictureL moment={stage.moment} at={at}
                reportLocal={stage.moment === 3 ? inStage / ONE_MS.report : 1} /></AsDemo></div>
            </div>
          </div>
        </div>
      ) : (
        <div role="group" aria-labelledby="step-one-title" className={cn(styles.staticOne, takeover.static)}>
          <div className={page.wrap}>
            <h3 id="step-one-title" className={styles.stepTitle}>{L_STEPS.one.title}</h3>
            {stages.map(item => (
              <article key={item.label} className={takeover.staticStep} data-region="第一步的阶段">
                <div className={takeover.caption}><h3>{item.label}<DemoTag /></h3><p>{item.note}</p></div>
                <div className={takeover.picture}><AsDemo><PositioningPictureL moment={item.moment} at={null} /></AsDemo></div>
              </article>
            ))}
          </div>
        </div>
      )}
      <div className={cn(k.wrap, styles.after)}><CtaK /></div>
      <LaterStepsL flags={flags} />
    </section>
  );
}
