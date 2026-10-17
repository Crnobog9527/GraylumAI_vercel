/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDown } from 'lucide-react';
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
import { usePlayClock } from './use-play-clock';

/** Scrolling down while the step plays speeds it up this much, for this long after the last push. */
const BOOST = 3;
const BOOST_MS = 900;
const SEEN_KEY = 'graylum-landing-l-step-one-seen';
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const readSeen = () => { try { return window.localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const writeSeen = () => { try { window.localStorage.setItem(SEEN_KEY, '1'); } catch { /* private window: not remembered */ } };

/**
 * Region 3 (Owner 2026-10-17): 第一步/第二步/第三步. Step one is the whole positioning flow on the real product's display
 * components (PositioningPictureL). Round seven (T2): it plays by itself once on screen, in time, every message typed
 * (step-one-timeline.ts), its four stages in order, and the stage holds still meanwhile. The page cannot be scrolled
 * past it before the end on a first visit: scrolling down only speeds the play up (three times) and the page follows
 * it. The pointer on the conversation, or scrolling it, pauses the play. A visitor who has seen it before (remembered
 * in this browser) scrolls freely and gets a button that jumps past it. Steps two and three follow (LaterStepsL).
 * Server HTML and reduced motion: the four stages stacked, finished.
 */
export function StepsL({ flags }: { flags: LandingFlags }) {
  const stages = visibleItems(flags, L_STEPS.one.stages);
  const durations = useMemo(() => stages.map(stage => (stage.moment === 3 ? ONE_MS.report : momentMs(stepOneScript(stage.moment)))), [stages]);
  const total = durations.reduce((sum, ms) => sum + ms, 0);
  const ref = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(false);
  const [seen, setSeen] = useState(false);
  const [inView, setInView] = useState(false);
  const [holding, setHolding] = useState(false);
  const boostUntil = useRef(0);
  const rate = useCallback(() => (performance.now() < boostUntil.current ? BOOST : 1), []);
  const ms = usePlayClock(locked && inView && !holding, total, rate);
  const done = ms >= total;
  const state = useRef({ ms, total, free: seen || done });
  state.current = { ms, total, free: seen || done };

  useEffect(() => { setLocked(!reducedMotion()); setSeen(readSeen()); }, []);
  useEffect(() => {
    const node = ref.current;
    if (!locked || !node) return;
    const top = () => node.getBoundingClientRect().top + window.scrollY;
    // How far down the page may go: the step's track, as far as the play has got.
    const allowed = () => top() + Math.max(0, node.offsetHeight - window.innerHeight) * (state.current.ms / state.current.total);
    const inChat = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[data-step-one-chat]'));
    // Only a visitor scrolling inside the step is held; a jump past it (a link in the menu) is left alone.
    const inside = (y: number) => y >= top() - 2 && y <= allowed() + 4;
    let lastY = window.scrollY;
    const hold = (down: number, event?: Event) => {
      if (state.current.free || down <= 0 || !inside(window.scrollY)) return;
      if (window.scrollY + down <= allowed()) return;
      event?.preventDefault();
      boostUntil.current = performance.now() + BOOST_MS;
    };
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      setInView(rect.top < window.innerHeight * 0.35 && rect.bottom > window.innerHeight * 0.65);
      if (!state.current.free && inside(lastY) && window.scrollY > allowed() + 4 && window.scrollY - lastY < window.innerHeight * 2) {
        boostUntil.current = performance.now() + BOOST_MS;
        window.scrollTo({ top: allowed(), behavior: 'instant' });
      }
      lastY = window.scrollY;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const onWheel = (event: WheelEvent) => { if (!inChat(event.target)) hold(event.deltaY, event); };
    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (!inChat(event.target)) hold(touchY - y, event);
      touchY = y;
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll);
      window.removeEventListener('wheel', onWheel); window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
    };
  }, [locked]);

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
        <div ref={ref} role="group" aria-labelledby="step-one-title" className={cn(takeover.takeover, styles.story)}>
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
              <div className={takeover.picture}><PositioningPictureL moment={stage.moment} at={at}
                reportLocal={stage.moment === 3 ? inStage / ONE_MS.report : 1} onHold={setHolding} /></div>
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
                <div className={takeover.picture}><PositioningPictureL moment={item.moment} at={null} /></div>
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
