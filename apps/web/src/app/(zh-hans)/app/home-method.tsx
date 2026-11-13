'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { HOME_STEP_LABELS, HOME_STEPS } from './home-steps';
import { HOME_VISUALS } from './home-visuals';
import styles from './home-method.module.css';

const TINTS = [styles.warm, styles.lilac, styles.peach];
const number = (index: number) => String(index + 1).padStart(2, '0');

/** A phone, where the six steps stand one under another (home-method.module.css's block for the same width). */
const PHONE = '(max-width: 639px)';
const watchPhone = (changed: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
};

/**
 * The six method steps as a route (Owner 2026-11-12: "这 6 个模块最好能尽可能做成可视化的模块，不要全是文字", sample
 * H1, "6 个步骤都做成一个带动效播放的动画"). The six stops stand in a row; choosing one shows that step: its picture,
 * playing, beside the step's own text. The copy is home-steps.ts's, unchanged, and all six steps are in the page as one
 * ordered list whichever is shown. The steps share one place and its height is the tallest step's, so choosing a step
 * moves nothing below it.
 *
 * On a phone (Owner 2026-11-12: "不要做左右滑动，直接从上到下排列好……带步骤动效、有箭头引导") the same list is laid out
 * top to bottom with an arrow between steps, and this watches which steps are on screen: a step arrives the first time it
 * is reached (`data-seen`) and its picture plays while it is in view (`data-play`). Until the page has looked once
 * (`data-watch`), and wherever it cannot look, every step simply shows and the first one's picture plays, as on a computer.
 */
export function HomeMethod() {
  const [shown, setShown] = useState(0);
  const id = useId();
  const route = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const phone = useSyncExternalStore(watchPhone, () => window.matchMedia(PHONE).matches, () => false);
  const [inView, setInView] = useState<readonly number[]>([]);
  const [seen, setSeen] = useState<readonly number[]>([]);
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    const steps = list.current ? [...list.current.children] : [];
    if (!phone || !steps.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const now = entries.map(entry => [steps.indexOf(entry.target), entry.isIntersecting] as const);
      const entered = now.filter(([, on]) => on).map(([index]) => index);
      setInView(before => [...before.filter(index => !now.some(([changed]) => changed === index)), ...entered]);
      setSeen(before => [...new Set([...before, ...entered])]);
      setWatching(true);
    }, { threshold: 0.2 });
    steps.forEach(step => observer.observe(step));
    return () => { observer.disconnect(); setInView([]); setWatching(false); };
  }, [phone]);
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
      <ol className={styles.panels} ref={list} data-watch={(phone && watching) || undefined}>
        {HOME_STEPS.map((step, index) => (
          <li
            key={step.title} id={`${id}-${index}`} className={styles.panel} data-on={index === shown || undefined}
            data-play={(phone && watching ? inView.includes(index) : index === shown) || undefined} data-seen={seen.includes(index) || undefined}
          >
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
