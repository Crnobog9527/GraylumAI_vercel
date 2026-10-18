/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import { OpsChatL } from '@/components/landing/preview-l/OpsChatL';
import l from '@/components/landing/preview-l/l.module.css';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import type { LandingFlags } from '@/lib/landing/landing-flags';
import { L_OPS } from '@/lib/landing/landing-copy-l';
import { cn } from '@/lib/utils';
import styles from './n.module.css';

type Step = (typeof L_OPS.steps)[number];
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Region 3, one week of operations, as cells (direction E) around sample L's carousel (Owner 2026-10-17: it must
 * play by itself, or people never find out the steps can be clicked). The big cell holds L's step buttons — each
 * shows its progress; the steps play on once on screen, every step can be clicked, arrow keys move between them, and
 * the pointer over the region, keyboard focus in it or the pause button holds it — and ONE chat window for the current
 * step (OpsChatL, unchanged). Beside it, the current step's line, and the week's close with the button. The big cell
 * is the frame's key cell. Reduced motion: no autoplay.
 */
export function OpsN({ steps, flags }: { steps: readonly Step[]; flags: LandingFlags }) {
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
    <section ref={ref} id="how-it-works" aria-labelledby="ops-title" className={styles.section} data-zone="takeover" data-region="日常运营"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="ops-title" className={styles.h2}>
            {HOW_IT_WORKS.title.split(/(?=怎么)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
          </h2>
          <p className={styles.lede}>{L_OPS.lede}</p>
        </div>
        <div className={cn(styles.grid, styles.opsGrid)}>
          <div className={cn(styles.cell, styles.opsMain)} data-cell="" data-region="步骤和对话" data-key="">
            <div className={styles.opsBar}>
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
            <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`}>
              <OpsChatL key={current.label} step={current} stepName={current.label} flags={flags} />
            </div>
          </div>
          <div className={styles.opsSide}>
            <p className={cn(styles.cell, styles.opsLine)} data-cell="" data-region="这一步" aria-live="polite">
              <b>{active + 1} · {current.label}</b>{current.line}
            </p>
            <div className={cn(styles.cell, styles.opsClose)} data-cell="" data-region="这一周">
              <p>{L_OPS.close}</p>
              <CtaK />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
