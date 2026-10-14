/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { J_WORK, J_WORK_SCENES } from '@/lib/landing/landing-copy-j-work';
import { cn } from '@/lib/utils';
import { WorkScreenJ } from './WorkScreensJ';
import styles from './work-j.module.css';
import page from './j.module.css';

/** How long each phase of a demo shows, and the pause on its finished screen before the next demo starts. */
export const WORK_PHASE_MS = 1500;
export const WORK_HOLD_MS = 2600;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The merged module (Owner 2026-10-15), sample H's layout: on the left the list of what the coach takes off your hands
 * (five) and what it does with you after positioning (library, voice, publishing), in two groups; in the middle the
 * real product playing the open demo; on the right what this screen does and what you get. While nobody has touched
 * it and it is on screen, each demo plays through its phases and hands over to the next; a click or arrow key takes
 * over. The server HTML and reduced motion show every demo finished (inactive ones `hidden`).
 */
export function WorkJ({ flags }: { flags: LandingFlags }) {
  const scenes = J_WORK_SCENES.filter(scene => allOn(flags, scene.needs));
  const [active, setActive] = useState(0);
  // -1: at rest, every screen finished. 0 and up: the open demo's phase while playing.
  const [phase, setPhase] = useState(-1);
  const [auto, setAuto] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const shown = entries.some(entry => entry.isIntersecting);
      setVisible(shown);
      if (shown) setPhase(current => (current < 0 ? 0 : current));
    }, { rootMargin: '-25% 0px -25% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const current = Math.min(active, Math.max(0, scenes.length - 1));
  const scene = scenes[current];
  useEffect(() => {
    if (!scene || phase < 0 || !visible) return;
    const last = phase >= scene.phases - 1;
    if (last && (!auto || current >= scenes.length - 1)) return;
    const timer = window.setTimeout(() => {
      if (!last) setPhase(phase + 1);
      else { setActive(current + 1); setPhase(0); }
    }, last ? WORK_HOLD_MS : WORK_PHASE_MS);
    return () => window.clearTimeout(timer);
  }, [scene, phase, visible, auto, current, scenes.length]);

  if (!scene) return null;

  const select = (index: number, focus = false) => {
    setAuto(false);
    setActive(index);
    setPhase(value => (value < 0 ? -1 : 0));
    if (focus) document.getElementById(`j-work-${scenes[index].id}-tab`)?.focus({ preventScroll: true });
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;
    event.preventDefault();
    select((current + (forward ? 1 : -1) + scenes.length) % scenes.length, true);
  };

  return (
    <section aria-labelledby="work-title" className={page.section} data-zone="work">
      <div className={page.wrap}>
        <div className={page.sectionHead}>
          <h2 id="work-title" className={page.display}>{J_WORK.groups[0]}</h2>
          <p className={page.lede}>{J_WORK.close}{J_WORK.lede}</p>
        </div>
        <div ref={ref} className={styles.player}>
          <div role="tablist" aria-label={J_WORK.groups.join('；')} aria-orientation="vertical" className={styles.list}>
            {[0, 1].map(group => (
              <div key={group} className={styles.group}>
                <p className={styles.groupTitle}>{J_WORK.groups[group]}</p>
                {scenes.map((item, index) => (item.group !== group ? null : (
                  <button key={item.id} id={`j-work-${item.id}-tab`} type="button" role="tab" aria-selected={index === current}
                    aria-controls={`j-work-${item.id}-panel`} tabIndex={index === current ? 0 : -1}
                    onClick={() => select(index)} onKeyDown={onKey}>
                    {item.title}
                    {index === current && phase >= 0 ? (
                      <i className={styles.progress} aria-hidden="true"
                        style={{ animationDuration: `${item.phases * WORK_PHASE_MS + WORK_HOLD_MS}ms` }} key={`${current}-${auto}`} />
                    ) : null}
                  </button>
                )))}
              </div>
            ))}
          </div>

          {scenes.map((item, index) => (
            <div key={item.id} id={`j-work-${item.id}-panel`} role="tabpanel" aria-labelledby={`j-work-${item.id}-tab`}
              hidden={index !== current} className={styles.panel}>
              <div className={styles.window} inert aria-hidden="true">
                <div className={styles.bar}><span className={styles.dots}><i /><i /><i /></span><span className={styles.badge}>{DEMO_LABEL}</span>{item.title}</div>
                <div className={styles.screen}>
                  <WorkScreenJ id={item.id} phase={index === current && phase >= 0 ? phase : item.phases - 1} />
                </div>
              </div>
              <aside className={styles.aside}>
                <p className={styles.asideLabel}>{J_WORK.rightLabel}</p>
                <h3>{item.title}</h3>
                <p>{item.did}</p>
                <div className={styles.result}><p className={styles.asideLabel}>{J_WORK.resultLabel}</p><p>{item.result}</p></div>
                <button type="button" className={cn(styles.next)} onClick={() => select((index + 1) % scenes.length, true)}>
                  {J_WORK.next}：{scenes[(index + 1) % scenes.length].title}<ArrowRight size={16} aria-hidden="true" />
                </button>
              </aside>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
