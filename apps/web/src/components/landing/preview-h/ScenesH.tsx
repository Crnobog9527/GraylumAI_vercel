/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { DEMO_LABEL, DEMO_NOTE } from '@/components/landing/demo/demo-script';
import { findScene, type SceneLine } from '@/components/landing/preview-g/scenes';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import { SceneCardH } from './SceneCardH';
import { sceneTimeline, type LineTiming } from './scene-timing';
import styles from './scenes-h.module.css';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
/** Pause after a scene finishes before the next one starts on its own. */
export const AUTO_PAUSE_MS = 2200;

/**
 * Module 3's nine steps as conversations (the same scripts as sample G): a glass rail of the nine titles (chips on
 * a phone) and one chat window per step. Every panel is in the server HTML (inactive ones `hidden`), so all the
 * copy is readable without JavaScript. Once the window scrolls into view, the open scene plays: your messages pop
 * in, the coach shows typing dots and types its reply, cards rise in after it. Switching scenes replays the new
 * one. While nobody has touched it, a finished scene hands over to the next after a short pause (only while the
 * window is on screen, and not past the last step); the first click, key or "下一个" hands control to the visitor.
 * With reduced motion nothing plays and every message is simply there.
 */
export function ScenesH({ steps }: { steps: readonly FlowStep[] }) {
  const [active, setActive] = useState(0);
  // 0: show everything at rest. Above 0: a play token; bumping it replays the open scene from the start.
  const [run, setRun] = useState(0);
  // Scenes advance on their own until the visitor picks one.
  const [auto, setAuto] = useState(true);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const observer = new IntersectionObserver(entries => {
      const shown = entries.some(entry => entry.isIntersecting);
      setVisible(shown);
      if (shown) setRun(token => token || 1);
    }, { rootMargin: '-20% 0px -30% 0px' });
    observer.observe(node);
    const onPreference = () => { if (reducedMotion()) setRun(0); };
    media?.addEventListener?.('change', onPreference);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', onPreference);
    };
  }, []);

  const current = Math.min(active, Math.max(steps.length - 1, 0));
  const last = current >= steps.length - 1;
  const currentId = steps[current]?.id;

  useEffect(() => {
    if (!auto || !visible || run === 0 || last || !currentId) return;
    const { total } = sceneTimeline(findScene(currentId)?.lines ?? []);
    const timer = window.setTimeout(() => {
      const index = current + 1;
      setActive(index);
      setRun(token => token + 1);
      // Bring the new chip into the phone's scrolling row without moving the page.
      const tabs = tabsRef.current;
      const tab = document.getElementById(`h-${steps[index].id}-tab`);
      if (tabs && tab && tabs.scrollWidth > tabs.clientWidth) {
        const left = tabs.scrollLeft + tab.getBoundingClientRect().left - tabs.getBoundingClientRect().left - 16;
        tabs.scrollTo({ left, behavior: 'smooth' });
      }
    }, total + AUTO_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [auto, visible, run, last, current, currentId, steps]);

  if (steps.length === 0) return null;

  function select(index: number, focus = false) {
    setAuto(false);
    setActive(index);
    setRun(token => (token > 0 ? token + 1 : 0));
    if (!focus) return;
    const tab = document.getElementById(`h-${steps[index].id}-tab`);
    tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;
    event.preventDefault();
    select((current + (forward ? 1 : -1) + steps.length) % steps.length, true);
  }

  return (
    <div ref={rootRef} className={styles.scenes}>
      <div ref={tabsRef} role="tablist" aria-label="九个场景" aria-orientation="vertical" className={styles.toc}>
        {steps.map((step, index) => (
          <button key={step.id} id={`h-${step.id}-tab`} type="button" role="tab" aria-selected={index === current}
            aria-controls={`h-${step.id}-panel`} tabIndex={index === current ? 0 : -1}
            onClick={() => select(index)} onKeyDown={onKey}>
            <span className={styles.tocIndex} aria-hidden="true">{index + 1}</span>
            <span className={styles.tocTitle}>{step.title}</span>
          </button>
        ))}
      </div>

      {steps.map((step, index) => {
        const scene = findScene(step.id);
        const lines = scene?.lines ?? [];
        const open = index === current;
        const playing = open && run > 0;
        const { timings, total } = sceneTimeline(lines);
        const next = steps[(index + 1) % steps.length];
        return (
          <div key={step.id} id={`h-${step.id}-panel`} role="tabpanel" aria-labelledby={`h-${step.id}-tab`}
            hidden={!open} className={styles.panel}>
            <div key={playing ? run : 'rest'} className={styles.window} data-play={playing ? '' : undefined}
              style={{ '--total': `${total}ms` } as CSSProperties}>
              <div className={styles.chrome}>
                <span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>
                <span className={styles.badge}>{DEMO_LABEL}</span>
                <span className={styles.chromeTitle}>{scene?.context ?? step.title}</span>
                <span className={styles.progress} aria-hidden="true" />
              </div>
              <ol className={styles.log} aria-label={`${step.title}：示例对话`}>
                {lines.map((line, order) => (
                  <Message key={order} line={line} timing={playing ? timings[order] : null} />
                ))}
              </ol>
              <p className={styles.disclaimer}>{DEMO_NOTE}</p>
            </div>

            <aside className={styles.aside}>
              <h3 className={styles.asideTitle}><span aria-hidden="true">{index + 1}</span>{step.title}</h3>
              <p className={styles.asideDemo}>{step.demo}</p>
              <div className={styles.asideNote}>
                <p className={styles.asideLabel}>{FLOW_NOTE_LABEL}</p>
                <p>{step.note}</p>
              </div>
              {steps.length > 1 ? (
                <button type="button" className={styles.next} onClick={() => select((index + 1) % steps.length, true)}>
                  下一个：{next.title}<ArrowRight size={16} aria-hidden="true" />
                </button>
              ) : null}
            </aside>
          </div>
        );
      })}
    </div>
  );
}

function Message({ line, timing }: { line: SceneLine; timing: LineTiming | null }) {
  const coach = line.role === 'coach';
  const style = timing ? ({
    '--appear': `${timing.appear}ms`,
    '--type-start': `${timing.typeStart}ms`,
    '--card-at': `${timing.cardAt ?? 0}ms`,
  } as CSSProperties) : undefined;
  return (
    <li className={styles.message} data-role={line.role} style={style}>
      <span className={styles.who}>{coach ? '教练' : '你'}</span>
      <div className={styles.bubble}>
        {timing && coach ? <span className={styles.typing} aria-hidden="true"><i /><i /><i /></span> : null}
        <p>{timing && coach ? <Typed text={line.text} start={timing.typeStart} step={timing.perChar} /> : line.text}</p>
      </div>
      {line.card ? <div className={styles.cardWrap}><SceneCardH card={line.card} /></div> : null}
    </li>
  );
}

/** The reply typed out: each character appears on its own delay. Layout is the finished text from the start. */
function Typed({ text, start, step }: { text: string; start: number; step: number }) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {Array.from(text).map((char, index) => (
          <span key={index} className={styles.tc} style={{ animationDelay: `${start + index * step}ms` }}>{char}</span>
        ))}
      </span>
    </>
  );
}
