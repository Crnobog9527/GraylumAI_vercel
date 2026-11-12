'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { HOME_STEP_LABELS, HOME_STEPS } from './home-steps';
import { HOME_VISUALS } from './home-visuals';
import styles from './home-method.module.css';

const TINTS = [styles.warm, styles.lilac, styles.peach];
const number = (index: number) => String(index + 1).padStart(2, '0');

/**
 * The six method steps as a route (Owner 2026-11-12: "这 6 个模块最好能尽可能做成可视化的模块，不要全是文字", sample
 * H1, "6 个步骤都做成一个带动效播放的动画"). The six stops stand in a row; choosing one shows that step: its picture,
 * playing, beside the step's own text. The copy is home-steps.ts's, unchanged, and all six steps are in the page as one
 * ordered list whichever is shown. The steps share one place and its height is the tallest step's, so choosing a step
 * moves nothing below it.
 */
export function HomeMethod() {
  const [shown, setShown] = useState(0);
  const id = useId();
  const route = useRef<HTMLDivElement>(null);
  const show = (index: number) => {
    setShown(index);
    // On a phone the six stops scroll sideways: bring the chosen one to the middle, without moving the page.
    const strip = route.current;
    const stop = strip?.children[index] as HTMLElement | undefined;
    if (strip && stop && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: stop.offsetLeft - (strip.clientWidth - stop.offsetWidth) / 2 });
  };
  return (
    <section className={styles.method} aria-label="我们怎样帮你做定位">
      <div className={styles.route} ref={route}>
        {HOME_STEPS.map((step, index) => (
          <button
            key={step.title} type="button" aria-controls={`${id}-${index}`} aria-current={index === shown ? 'step' : undefined}
            data-done={index < shown || undefined} onClick={() => show(index)}
          >
            <b>{number(index)}</b>{step.title}
          </button>
        ))}
      </div>
      <ol className={styles.panels}>
        {HOME_STEPS.map((step, index) => (
          <li key={step.title} id={`${id}-${index}`} className={styles.panel} data-on={index === shown || undefined}>
            <div className={`${styles.picture} ${TINTS[index % TINTS.length]}`} aria-hidden="true"><div className={styles.viz}>{HOME_VISUALS[index]}</div></div>
            <div className={styles.text}>
              <h3><span className={styles.stepNumber}>{number(index)}</span>{step.title}</h3>
              <dl>{HOME_STEP_LABELS.map(([key, label]) => <div key={key} data-part={key}><dt>{label}</dt><dd>{step[key]}</dd></div>)}</dl>
            </div>
          </li>
        ))}
      </ol>
      <div className={styles.turn}>
        <button type="button" disabled={shown === 0} onClick={() => show(shown - 1)}><ArrowLeft size={15} aria-hidden="true" />上一步</button>
        <span><b>{number(shown)}</b> / {number(HOME_STEPS.length - 1)}</span>
        <button type="button" disabled={shown === HOME_STEPS.length - 1} onClick={() => show(shown + 1)}>下一步<ArrowRight size={15} aria-hidden="true" /></button>
      </div>
    </section>
  );
}
