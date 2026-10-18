/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { FileText, MessagesSquare, PenLine } from 'lucide-react';
import { useOwnerEditing } from '@/components/landing/preview-j/use-owner-editing';
import { L_JURY } from '@/lib/landing/landing-copy-l-steps';
import styles from './jury-circuit-l.module.css';

/**
 * When (seconds into the 13-second loop) each part lights up: the report runs down the circuit to "你来决定" (round ten,
 * W4, Owner 2026-10-18). Report 0–1.2; A, B, C about 0.4 apart, with their marks, to 4.0; the cross review 4–6; the lead
 * writer and its ring 6–7.4; the line 7.4–8.2; only then the title, and the chapters one by one 0.35 apart, each choice
 * picked 0.4 after its row; all is in place by about 10 and holds; at 12.5 everything dims together (the CSS), and at 13
 * the loop starts again from the report, with the title and chapters back out of sight.
 */
const AT = { report: 0, wire1: 0.8, reviewers: 1.2, wire2: 3.4, cross: 4, wire3: 5.6, lead: 6, wire4: 7.1, decide: 7.4, title: 8.2, chapters: 8.5 };
const STEP = { reviewer: 0.4, chapter: 0.35, pick: 0.4 };
const at = (seconds: number, extra: CSSProperties = {}) => ({ '--at': `${seconds}s`, ...extra }) as CSSProperties;

/** A stretch of the circuit between two parts, with the light that runs down it. */
function Wire({ start }: { start: number }) {
  return (
    <svg className={styles.wire} viewBox="0 0 12 26" aria-hidden="true">
      <line x1="6" y1="0" x2="6" y2="26" />
      <circle className={styles.spark} cx="6" cy="2" r="3" style={at(start)} />
    </svg>
  );
}

/**
 * The jury as a working circuit (round nine, V4, Owner 2026-10-18: "把这个工作电路做成动态状态"), by /impeccable animate.
 * Its one authored moment: a report runs through the jury and stops at "你来决定". Light runs down each wire to the next
 * part; the three reviewers each light and their marks pop up one by one; where they disagree, light runs back and forth
 * between them; the lead writer's ring fills; then the three chapters are picked in turn. CSS and SVG only (no motion
 * library): opacity, transform and stroke offsets, cubic-bezier(.16, 1, .3, 1), a loop that runs only while on
 * screen and the tab is visible (13 seconds since round ten: each part lights once, then all dim together and it starts
 * over). Reduced motion: no loop, the parts fade in once in order and stay in their final state.
 * The words are the module's own (L_JURY.anim), unchanged.
 */
export function JuryCircuitL() {
  const a = L_JURY.anim;
  const ref = useRef<HTMLElement>(null);
  const [play, setPlay] = useState(false);
  const [armed, setArmed] = useState(false);
  const [cycle, setCycle] = useState(0);
  // The Owner's local edit mode holds it still, in its final state (no loop).
  const editing = useOwnerEditing();
  useEffect(() => {
    const node = ref.current;
    setArmed(true);
    if (!node || typeof IntersectionObserver === 'undefined') return;
    let seen = false;
    const update = () => setPlay(seen && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(entries => { seen = entries.some(entry => entry.isIntersecting); update(); }, { threshold: 0.3 });
    observer.observe(node);
    document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  return (
    <figure ref={ref} className={styles.circuit} aria-label={a.label} data-armed={(armed && !editing) || undefined} data-play={play || undefined}>
      {/* Each loop is a fresh mount, so every part starts dim again together; the clock ends the loop (paused with it). */}
      <div key={cycle} className={styles.loop}>
        <span className={styles.clock} aria-hidden="true" onAnimationEnd={() => setCycle(count => count + 1)} />
        <p className={styles.node} data-lit="" style={at(AT.report, { '--order': 0 } as CSSProperties)}>
          <FileText size={16} aria-hidden="true" />{a.report}
        </p>
        <Wire start={AT.wire1} />
        <ul className={styles.reviewers}>
          {a.reviewers.map((name, index) => (
            <li key={name} className={styles.node} data-lit="" style={at(AT.reviewers + index * STEP.reviewer, { '--order': 1 + index } as CSSProperties)}>
              <b>{name}</b><span>{a.review}</span>
              <span className={styles.marks} aria-hidden="true">
                {[0, 1].map(mark => <i key={mark} style={at(AT.reviewers + 0.4 + index * STEP.reviewer + mark * 0.25)} />)}
              </span>
            </li>
          ))}
        </ul>
        <Wire start={AT.wire2} />
        <p className={`${styles.node} ${styles.cross}`} data-lit="" style={at(AT.cross, { '--order': 4 } as CSSProperties)}>
          <svg className={styles.triangle} viewBox="0 0 48 32" aria-hidden="true">
            {['M8 26 Q24 34 40 26', 'M8 26 Q8 8 24 6', 'M40 26 Q40 8 24 6'].map((path, index) => (
              <g key={path}>
                <path d={path} className={styles.arc} />
                <path d={path} className={styles.pulse} pathLength={100} style={at(AT.cross + 0.3 + index * 0.5)} />
              </g>
            ))}
            {[[8, 26], [40, 26], [24, 6]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.2" />)}
          </svg>
          <MessagesSquare size={15} aria-hidden="true" />{a.debate}
        </p>
        <Wire start={AT.wire3} />
        <p className={`${styles.node} ${styles.lead}`} data-lit="" style={at(AT.lead, { '--order': 5 } as CSSProperties)}>
          <PenLine size={15} aria-hidden="true" />{a.lead}
          <svg className={styles.ring} viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8" />
            <circle className={styles.fill} cx="10" cy="10" r="8" pathLength={100} style={at(AT.lead + 0.2)} />
          </svg>
        </p>
        <Wire start={AT.wire4} />
        <p className={styles.decide} data-lit="" style={at(AT.decide, { '--order': 6 } as CSSProperties)}>{a.decide}</p>
        <p className={styles.decideTitle} data-lit="" style={at(AT.title, { '--order': 6 } as CSSProperties)}>{a.decideTitle}</p>
        <ul className={styles.chapters}>
          {a.chapters.map((title, index) => {
            const keep = index === 1;
            return (
              <li key={title} className={styles.node} data-lit="" style={at(AT.chapters + index * STEP.chapter, { '--order': 7 + index } as CSSProperties)}>
                <span>{title}</span>
                {[a.adopt, a.keep].map(choice => {
                  const chosen = (choice === a.keep) === keep;
                  return (
                    <em key={choice} data-label={choice} data-on={chosen || undefined}
                      style={chosen ? at(AT.chapters + STEP.pick + index * STEP.chapter) : undefined}>
                      {choice}
                    </em>
                  );
                })}
              </li>
            );
          })}
        </ul>
      </div>
    </figure>
  );
}
