/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowRight, Pause, Play, RotateCw } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { PositioningClipJ } from '@/components/landing/preview-j/PositioningClipJ';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { L_OPS } from '@/lib/landing/landing-copy-l';
import { L_ACTS, type ActOneStep, type ActTwoStep } from '@/lib/landing/landing-copy-l-acts';
import { allOn, visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { WorkChatL } from './WorkChatL';
import acts from './acts-l.module.css';
import styles from './l.module.css';

type Step = { act: 0; one: ActOneStep } | { act: 1; two: ActTwoStep };
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
/** Where act one's conversation starts when its step comes up: the report is already written in part. */
const startOf = (step: Step) => (step.act === 0 && step.one.moment === 3 ? 0.35 : 0.08);

/**
 * Region 3 in two acts (Owner 2026-10-17, round three), nothing holding the scroll. Act one plays sample J's positioning
 * flow on the real workspace (PositioningClipJ, unchanged inside), each step's conversation arriving over its time; act
 * two plays the week in the real work chat (WorkChatL), each step with what you no longer worry about and what the coach
 * does. The steps run on by themselves from act one into act two once on screen, each with its progress; a click picks
 * any step (shown finished); the pointer or focus on the region, or the pause button, stops the move to the next step
 * (the current one still plays to its end). Reduced motion: every step finished, nothing moving on.
 */
export function ActsL({ flags }: { flags: LandingFlags }) {
  const one = visibleItems(flags, L_ACTS.one).map(item => ({ act: 0, one: item }) as Step);
  const two = visibleItems(flags, L_ACTS.two).map(item => ({ act: 1, two: item }) as Step);
  const steps = [...one, ...two];
  const [active, setActive] = useState(0);
  const [t, setT] = useState(1);
  const [seen, setSeen] = useState(false);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [still, setStill] = useState(true);
  const ref = useRef<HTMLElement>(null);
  const base = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    setStill(false);
    setT(0);
    const observer = new IntersectionObserver(entries => setSeen(entries.some(entry => entry.isIntersecting)), { threshold: 0.3 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const running = !still && seen;
  const advancing = running && !held && !stopped;
  const current = steps[Math.min(active, steps.length - 1)];
  const ms = current?.act === 0 ? L_ACTS.oneMs : L_ACTS.twoMs;
  // The step's own time: its conversation plays through it; at its end the next step comes up unless something holds.
  useEffect(() => {
    if (!running || t >= 1) {
      if (!advancing || t < 1) return;
      const timer = window.setTimeout(() => { setActive(index => (index + 1) % steps.length); setT(0); }, 400);
      return () => window.clearTimeout(timer);
    }
    let frame = 0;
    const begin = performance.now() - t * ms;
    const tick = (now: number) => {
      const next = Math.min(1, (now - begin) / ms);
      setT(previous => (next - previous > 0.01 || next === 1 ? next : previous));
      if (next < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, advancing, t, ms, steps.length]);

  if (!current) return null;
  const pick = (index: number) => { setActive(index); setT(1); };
  const actOf = current.act;
  const local = current.act === 0 ? startOf(current) + (1 - startOf(current)) * t : 1;
  const tabs = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.act === actOf);
  const label = (step: Step) => (step.act === 0 ? step.one.label : step.two.label);
  return (
    <section ref={ref} id="how-it-works" aria-labelledby="acts-title" className={k.section} data-zone="takeover" data-region="接手运营"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={k.wrap}>
        <h2 id="acts-title" className={k.lead}>
          {HOW_IT_WORKS.title.split(/(?=怎么)/).map(part => <span key={part} className={page.phrase}>{part}</span>)}
        </h2>
        <p className={styles.opsLede}>{L_OPS.lede}</p>

        <div className={acts.actTabs} role="tablist" aria-label={HOW_IT_WORKS.title}>
          {L_ACTS.acts.map((name, act) => {
            const first = steps.findIndex(step => step.act === act);
            if (first < 0) return null;
            return (
              <button key={name} type="button" role="tab" aria-selected={act === actOf} onClick={() => pick(first)}>{name}</button>
            );
          })}
        </div>

        <div className={styles.opsBar}>
          <div role="tablist" aria-label={L_ACTS.acts[actOf]} className={styles.opsSteps}>
            {tabs.map(({ step, index }, order) => (
              <button key={label(step)} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => pick(index)}>
                <span className={styles.opsNumber} aria-hidden="true">{order + 1}</span>{label(step)}
                <i className={styles.opsProgress} aria-hidden="true" style={{ scale: index === active ? `${t} 1` : '0 1' } as CSSProperties} />
              </button>
            ))}
          </div>
          {still ? null : (
            <button type="button" className={styles.opsPause} onClick={() => setStopped(value => !value)}>
              {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{stopped ? L_OPS.play : L_OPS.pause}
            </button>
          )}
        </div>

        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`} className={acts.panel}>
          {current.act === 0 ? (
            <>
              <p className={acts.note}><span className={styles.demoTag}>{DEMO_LABEL}</span><b>{L_ACTS.why}</b>{current.one.note}</p>
              <div className={acts.workspace}><PositioningClipJ moment={current.one.moment} local={local} /></div>
            </>
          ) : (
            <>
              <CarePair step={current.two} flags={flags} />
              <WorkChatL key={current.two.label} step={current.two} flags={flags} />
            </>
          )}
        </div>

        {actOf === 1 ? (
          <div className={acts.loop} data-region="每周循环">
            <ol>{two.map(step => <li key={label(step)}>{label(step)}</li>)}</ol>
            <p><RotateCw size={16} aria-hidden="true" />{L_ACTS.loop}</p>
          </div>
        ) : null}
        {allOn(flags, L_ACTS.jury.needs) ? (
          <p className={acts.jury}>{L_ACTS.jury.text}<Link href={L_ACTS.jury.href}>{L_ACTS.jury.link}<ArrowRight size={14} aria-hidden="true" /></Link></p>
        ) : null}
        <p className={styles.opsClose}>{L_OPS.close}</p>
        <CtaK />
      </div>
    </section>
  );
}

/** Act two's lead: the worry you drop, then what the coach does behind it (region 5's list, merged in). */
function CarePair({ step, flags }: { step: ActTwoStep; flags: LandingFlags }) {
  const swap = step.without && !flags[step.without.flag] ? step.without : null;
  return (
    <p className={acts.care}>
      <span className={styles.demoTag}>{DEMO_LABEL}</span>
      <span><small>{L_ACTS.worryLabel}</small><b>{swap?.worry ?? step.worry}</b></span>
      <ArrowRight size={18} aria-hidden="true" />
      <span><small>{L_ACTS.doesLabel}</small>{swap?.does ?? step.does}</span>
    </p>
  );
}
