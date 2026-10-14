/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { J_WORK, J_WORK_SCENES } from '@/lib/landing/landing-copy-j-work';
import { WorkScreenJ } from './WorkScreensJ';
import styles from './work-j.module.css';
import page from './j.module.css';

/** How long each step stays on screen while the demos play on their own (the Owner asked for six to eight seconds). */
export const WORK_STEP_MS = 7000;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The merged module (Owner 2026-10-15), sample H's layout: on the left the demos in two groups, the open one unfolded
 * into its steps (each step can be clicked to look again); in the middle the real product playing the open step; on
 * the right what this step does and what you get. While nobody has touched it and it is on screen, each step stays
 * seven seconds and the demos follow one another; a click takes over. The server HTML and reduced motion show each
 * demo's last step (the other demos `hidden`), nothing moving.
 */
export function WorkJ({ flags }: { flags: LandingFlags }) {
  const scenes = J_WORK_SCENES.filter(scene => allOn(flags, scene.needs));
  const [active, setActive] = useState(0);
  // -1: at rest (each demo's last step). 0 and up: the open step.
  const [step, setStep] = useState(-1);
  const [auto, setAuto] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const shown = entries.some(entry => entry.isIntersecting);
      setVisible(shown);
      if (shown) setStep(current => (current < 0 ? 0 : current));
    }, { rootMargin: '-25% 0px -25% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const current = Math.min(active, Math.max(0, scenes.length - 1));
  const scene = scenes[current];
  useEffect(() => {
    if (!scene || step < 0 || !visible || !auto) return;
    const last = step >= scene.steps.length - 1;
    if (last && current >= scenes.length - 1) return;
    const timer = window.setTimeout(() => {
      if (!last) setStep(step + 1);
      else { setActive(current + 1); setStep(0); }
    }, WORK_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [scene, step, visible, auto, current, scenes.length]);

  if (!scene) return null;
  const open = step < 0 ? scene.steps.length - 1 : Math.min(step, scene.steps.length - 1);
  const choose = (sceneIndex: number, stepIndex = 0) => {
    setAuto(false);
    setActive(sceneIndex);
    setStep(stepIndex);
  };

  return (
    <section aria-labelledby="work-title" className={page.section} data-zone="work">
      <div className={page.wrap}>
        <div className={page.sectionHead}>
          <h2 id="work-title" className={page.display}>{J_WORK.groups[0]}</h2>
          <p className={page.lede}>{J_WORK.close}{J_WORK.lede}</p>
        </div>
        <div ref={ref} className={styles.player}>
          <nav className={styles.list} aria-label={J_WORK.groups.join('；')}>
            {[0, 1].map(group => (
              <div key={group} className={styles.group}>
                <p className={styles.groupTitle}>{J_WORK.groups[group]}</p>
                {scenes.map((item, index) => (item.group !== group ? null : (
                  <div key={item.id} className={styles.sceneItem} data-open={index === current || undefined}>
                    <button type="button" aria-current={index === current ? 'true' : undefined} onClick={() => choose(index)}>{item.title}</button>
                    {index === current ? (
                      <ol className={styles.steps}>
                        {item.steps.map((one, at) => (
                          <li key={one.label} data-on={at === open || undefined} data-done={at < open || undefined}>
                            <button type="button" onClick={() => choose(index, at)} aria-current={at === open ? 'step' : undefined}>
                              <span aria-hidden="true">{at + 1}</span>{one.label}
                            </button>
                            {at === open && step >= 0 && auto ? (
                              <i className={styles.progress} aria-hidden="true" key={`${current}-${open}`}
                                style={{ animationDuration: `${WORK_STEP_MS}ms` }} />
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                )))}
              </div>
            ))}
          </nav>

          {scenes.map((item, index) => {
            const at = index === current ? open : item.steps.length - 1;
            const shown = item.steps[at];
            return (
              <div key={item.id} hidden={index !== current} className={styles.panel}>
                <div className={styles.window} inert aria-hidden="true">
                  <div className={styles.bar}>
                    <span className={styles.dots}><i /><i /><i /></span><span className={styles.badge}>{DEMO_LABEL}</span>
                    {item.title}<span className={styles.barStep}>第 {at + 1} 步 · {shown.label}</span>
                  </div>
                  <div className={styles.screen} key={`${index}-${at}`} data-play={step >= 0 || undefined}>
                    <WorkScreenJ blocks={shown.blocks} />
                  </div>
                </div>
                <aside className={styles.aside} aria-live="polite">
                  <p className={styles.asideLabel}>{J_WORK.rightLabel}</p>
                  <h3>{shown.label}</h3>
                  <p>{shown.explain}</p>
                  <div className={styles.result}><p className={styles.asideLabel}>{J_WORK.resultLabel}</p><p>{item.result}</p></div>
                  <button type="button" className={styles.next} onClick={() => choose((index + 1) % scenes.length)}>
                    {J_WORK.next}：{scenes[(index + 1) % scenes.length].title}<ArrowRight size={16} aria-hidden="true" />
                  </button>
                </aside>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
