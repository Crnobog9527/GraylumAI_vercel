/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Check, Pause, Play } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { OpsChatL } from '@/components/landing/preview-l/OpsChatL';
import l from '@/components/landing/preview-l/l.module.css';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_HERO_FLOW, L_OPS } from '@/lib/landing/landing-copy-l';
import { useOpsStep } from './stage-context-m';
import styles from './m.module.css';

type Step = (typeof L_OPS.steps)[number];
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
/** "What you get" here: sample L's own coach lines for the week (topics, scripts, next week), each behind its flag. */
const GETS = [1, 2, 4].map(index => L_HERO_FLOW.coachDoes.items[index]);

/**
 * Region 3, sample L's week of operations in direction H's form: the result as the heading (L's closing line, under
 * the region's name), L's lede, what you get, then L's five steps — playing on by themselves once on screen, each
 * clickable, held by the pointer, focus or the pause button (reduced motion: no autoplay). On a computer the step's
 * conversation shows in the fixed product window beside the page (the current step is shared with it); on a phone,
 * and with reduced motion, it sits right under the step, as in L. A button closes the region.
 */
export function OpsM({ steps, flags }: { steps: readonly Step[]; flags: LandingFlags }) {
  const [active, setActive] = useState(0);
  const [seen, setSeen] = useState(false);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [still, setStill] = useState(true);
  const ref = useRef<HTMLElement>(null);
  const base = useId();
  const { setStep } = useOpsStep();
  const gets = visibleItems(flags, GETS);

  useEffect(() => { setStep(active); }, [active, setStep]);
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    setStill(false);
    const observer = new IntersectionObserver(entries => setSeen(entries.some(entry => entry.isIntersecting)), { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const playing = !still && seen && !held && !stopped;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setActive(index => (index + 1) % steps.length), L_OPS.stepMs);
    return () => window.clearTimeout(timer);
  }, [playing, active, steps.length]);

  if (steps.length === 0) return null;
  const current = steps[active];
  return (
    <section ref={ref} id="how-it-works" aria-labelledby="ops-title" className={k.section} data-region="日常运营"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={k.wrap}>
        <div className={styles.head} data-region="结果和你得到什么">
          <h2 id="ops-title" className={styles.headline}>
            <span className={styles.kicker}>{HOW_IT_WORKS.title}</span>
            <span>{L_OPS.close}</span>
          </h2>
          <p className={styles.lede}>{L_OPS.lede}</p>
          {gets.length ? (
            <ul className={styles.gets}>{gets.map(item => <li key={item.text}><Check size={16} aria-hidden="true" />{item.text}</li>)}</ul>
          ) : null}
        </div>
        <div className={l.opsBar}>
          <div role="tablist" aria-label={HOW_IT_WORKS.title} className={l.opsSteps}>
            {steps.map((step, index) => (
              <button key={step.label} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1}
                onClick={() => setActive(index)}
                onKeyDown={event => {
                  const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!move) return;
                  const next = (active + move + steps.length) % steps.length;
                  setActive(next);
                  document.getElementById(`${base}-tab-${next}`)?.focus();
                }}>
                <span className={l.opsNumber} aria-hidden="true">{index + 1}</span>{step.label}
                {/* The current step's bar fills over its time on screen; a held or stopped carousel keeps it still. */}
                <i className={l.opsProgress} aria-hidden="true" data-run={(index === active && playing) || undefined}
                  key={`${active}-${index}`} style={{ '--ms': `${L_OPS.stepMs}ms` } as CSSProperties} />
              </button>
            ))}
          </div>
          {still ? null : (
            <button type="button" className={l.opsPause} onClick={() => setStopped(value => !value)}>
              {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{stopped ? L_OPS.play : L_OPS.pause}
            </button>
          )}
        </div>
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`} className={l.opsPanel}>
          <p className={l.opsLine}>{current.line}</p>
          <div className={styles.shot}><OpsChatL key={current.label} step={current} stepName={current.label} flags={flags} /></div>
        </div>
        <CtaK />
      </div>
    </section>
  );
}
