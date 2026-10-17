/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';
import compare from '@/components/landing/preview-j/compare-j.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { L_TASKS, L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { L_SCENARIOS } from '@/lib/landing/landing-copy-l-steps';
import { L_WORKFLOWS } from '@/lib/landing/landing-copy-l-workflows';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import styles from './scenarios-l.module.css';
import { WorkflowCompareL, workflowBeats } from './WorkflowCompareL';

/** How long one beat of the coach's work stays before the next (milliseconds). */
const BEAT_MS = 1100;

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Region 6, round four (Owner 2026-10-17: "不要把这几个情况全部一起展示出来，而是分批展示"): one scenario at a time. Tabs on
 * top; each scenario has its own title and one line saying the point, then the same question to a general AI and to
 * the coach, side by side: the general AI's usual answer, the coach's whole work conversation played beat by beat
 * (WorkflowCompareL, round five), then the one-line verdict. Once on screen the scenarios play
 * on by themselves; a click picks one, the pointer or focus on the region holds it, the button pauses. A scenario
 * whose capability is not built yet does not show; with one left, no tabs. Not a product window: the coach's side carries 示意.
 */
export function ScenariosL({ flags, after }: { flags: LandingFlags; after?: ReactNode }) {
  const items = L_TASKS.map((task, index) => ({ task, copy: L_SCENARIOS.items[index], turns: L_WORKFLOWS[index] ?? [] }))
    .filter(item => item.copy && allOn(flags, item.task.needs));
  const [active, setActive] = useState(0);
  const [beat, setBeat] = useState(0);
  const [seen, setSeen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const base = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    setMoving(true);
    const observer = new IntersectionObserver(entries => setSeen(entries.some(entry => entry.isIntersecting)), { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const current = items[Math.min(active, items.length - 1)];
  const playing = moving && seen && !stopped;
  const total = current ? workflowBeats(current.turns) : 0;
  // The coach works beat by beat; once the conversation is whole it holds, then the next scenario starts.
  useEffect(() => {
    if (!playing || !current) return;
    const last = beat >= total;
    if (last && (items.length < 2 || held)) return;
    const timer = window.setTimeout(() => {
      if (!last) { setBeat(value => value + 1); return; }
      setActive(index => (index + 1) % items.length); setBeat(0);
    }, last ? L_SCENARIOS.holdMs : BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [playing, held, beat, total, current, items.length]);
  const pick = (index: number) => { setActive(index); setBeat(0); };

  if (!current) return null;
  return (
    <section ref={ref} aria-labelledby="compare-title" className={page.section} data-zone="compare" data-band="ink" data-region="对比区"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={page.wrap}>
        <h2 id="compare-title" className={compare.title}>
          {L_TASKS_TITLE.split(/(?<=，)/).map(part => <span key={part} className={compare.phrase}>{part}</span>)}
        </h2>
        {items.length > 1 ? <div className={styles.bar}>
          <div role="tablist" aria-label={L_SCENARIOS.label} className={styles.tabs}>
            {items.map((item, index) => (
              <button key={item.copy.tab} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => pick(index)}>{item.copy.tab}</button>
            ))}
          </div>
          {moving && items.length > 1 ? (
            <button type="button" className={styles.pause} onClick={() => setStopped(value => !value)}>
              {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{stopped ? L_SCENARIOS.play : L_SCENARIOS.pause}
            </button>
          ) : null}
        </div> : null}
        <div role={items.length > 1 ? 'tabpanel' : undefined} id={`${base}-panel`}
          aria-labelledby={items.length > 1 ? `${base}-tab-${active}` : undefined} className={styles.panel} key={current.copy.tab}>
          <h3 className={styles.title}>{current.copy.title}</h3>
          <p className={styles.lede}>{current.copy.lede}</p>
          <WorkflowCompareL task={current.task} turns={current.turns} beat={moving ? beat : Infinity} badge={L_SCENARIOS.badge} />
        </div>
        {after}
      </div>
    </section>
  );
}
