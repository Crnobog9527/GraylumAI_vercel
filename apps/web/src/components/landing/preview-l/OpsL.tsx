/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import k from '@/components/landing/preview-k/k.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import type { LandingFlags } from '@/lib/landing/landing-flags';
import { L_OPS } from '@/lib/landing/landing-copy-l';
import { OpsChatL } from './OpsChatL';
import styles from './l.module.css';

type Step = (typeof L_OPS.steps)[number];
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Region 3, one week of operations (Owner 2026-10-17): you talk in plain words, the coach does the account's work —
 * topics, the script, a test of two openings, reading the result you paste in, a series from the winner. The steps play
 * on by themselves once on screen — each shows its progress — and every step can be clicked; the pointer over the
 * section, keyboard focus in it or the pause button holds it. Each step is that part of the week's conversation in a
 * wide window. Reduced motion: no autoplay.
 */
export function OpsL({ steps, flags }: { steps: readonly Step[]; flags: LandingFlags }) {
  const [active, setActive] = useState(0);
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
    <section ref={ref} id="how-it-works" aria-labelledby="ops-title" className={k.section} data-zone="takeover" data-region="日常运营"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={k.wrap}>
        <h2 id="ops-title" className={k.lead}>
          {HOW_IT_WORKS.title.split(/(?=怎么)/).map(part => <span key={part} className={page.phrase}>{part}</span>)}
        </h2>
        <p className={styles.opsLede}>{L_OPS.lede}</p>
        <div className={styles.opsBar}>
          <div role="tablist" aria-label={HOW_IT_WORKS.title} className={styles.opsSteps}>
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
                <span className={styles.opsNumber} aria-hidden="true">{index + 1}</span>{step.label}
                {/* The current step's bar fills over its time on screen; a held or stopped carousel keeps it still. */}
                <i className={styles.opsProgress} aria-hidden="true" data-run={(index === active && playing) || undefined}
                  key={`${active}-${index}`} style={{ '--ms': `${L_OPS.stepMs}ms` } as CSSProperties} />
              </button>
            ))}
          </div>
          {still ? null : (
            <button type="button" className={styles.opsPause} onClick={() => setStopped(value => !value)}>
              {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{stopped ? L_OPS.play : L_OPS.pause}
            </button>
          )}
        </div>
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`} className={styles.opsPanel}>
          <p className={styles.opsLine}>{current.line}</p>
          <OpsChatL key={current.label} step={current} stepName={current.label} flags={flags} />
        </div>
        <p className={styles.opsClose}>{L_OPS.close}</p>
      </div>
    </section>
  );
}
