/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import { OpsChatL } from '@/components/landing/preview-l/OpsChatL';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import type { LandingFlags } from '@/lib/landing/landing-flags';
import { L_OPS } from '@/lib/landing/landing-copy-l';
import { shownLines, stepNotes } from './copy-o';
import { StationO } from './RouteO';
import styles from './o.module.css';

type Step = (typeof L_OPS.steps)[number];
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const NOTE_GAP = 12;

/**
 * Region 3, sample L's week of operations on the route: each step is a station in the rail (numbered from `first`),
 * the step list runs down beside the chat window (OpsChatL, unchanged inside), and the step's own line stands beside
 * the window as one or two numbered notes, each pinned to the message it describes. Plays on by itself once on screen
 * as in sample L; the pointer, focus or the pause button holds it; every step can be picked. Reduced motion: no autoplay.
 */
export function OpsO({ steps, flags, first }: { steps: readonly Step[]; flags: LandingFlags; first: number }) {
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
  const pick = (next: number) => { setActive(next); document.getElementById(`${base}-tab-${next}`)?.focus(); };
  return (
    <section ref={ref} id="how-it-works" aria-labelledby="ops-title" className={styles.section} data-region="日常运营"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="ops-title" className={styles.title}>
            {HOW_IT_WORKS.title.split(/(?=怎么)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
          </h2>
          <p className={styles.lede}>{L_OPS.lede}</p>
        </div>
        <div className={styles.opsBody}>
          <div className={styles.opsSide}>
            <div role="tablist" aria-label={HOW_IT_WORKS.title} aria-orientation="vertical" className={styles.opsSteps}>
              {steps.map((step, index) => (
                <button key={step.label} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel`}
                  aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)}
                  onKeyDown={event => {
                    const move = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0;
                    if (!move) return;
                    event.preventDefault();
                    pick((active + move + steps.length) % steps.length);
                  }}>
                  <StationO n={String(first + index)} />
                  <span>{step.label}</span>
                  {/* The current step's time on screen, as a thin gold line; held or stopped, it stays still. */}
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
            <AnnotatedStep key={current.label} step={current} flags={flags} />
          </div>
        </div>
        <p className={styles.opsClose}>{L_OPS.close}</p>
        <CtaK />
      </div>
    </section>
  );
}

/**
 * One step's chat window with its numbered notes. On a wide screen each note stands level with the message it points
 * at (a matching number sits on the window's edge there), pushed down only to keep clear of the note above; on a phone
 * the notes follow the window in order.
 */
function AnnotatedStep({ step, flags }: { step: Step; flags: LandingFlags }) {
  const lines = shownLines(step.lines, flags);
  const notes = stepNotes(step.line, lines);
  const frame = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [spots, setSpots] = useState<{ mark: number; note: number }[]>([]);

  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    const measure = () => {
      const log = root.querySelector('[inert]')?.lastElementChild;
      const top = root.getBoundingClientRect().top;
      const items = Array.from(list.current?.children ?? []) as HTMLElement[];
      let floor = 0;
      setSpots(notes.map((note, index) => {
        const target = log?.children[note.at]?.getBoundingClientRect();
        const mark = target ? Math.round(target.top - top + 14) : 24;
        const at = Math.max(mark - 24, floor);
        floor = at + (items[index]?.offsetHeight ?? 0) + NOTE_GAP;
        return { mark, note: at };
      }));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => observer?.disconnect();
    // The notes are derived from the step, which keys this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.opsStep}>
      <div ref={frame} className={styles.opsFrame}>
        <OpsChatL step={step} stepName={step.label} flags={flags} />
        {spots.map((spot, index) => (
          <span key={index} className={styles.mark} aria-hidden="true"
            style={{ top: spot.mark, '--m': notes[index].at } as CSSProperties}>{index + 1}</span>
        ))}
      </div>
      <ol ref={list} className={styles.notes} aria-label={step.label}>
        {notes.map((note, index) => (
          <li key={note.text} style={{ '--y': `${spots[index]?.note ?? 0}px`, '--m': note.at } as CSSProperties}>
            <b aria-hidden="true">{index + 1}</b>{note.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
