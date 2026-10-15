/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight, BookOpen, Check, Compass, FileText, MessageCircle, PenLine, RotateCcw, Search, Send, Sparkles, TrendingUp, Users,
  type LucideIcon,
} from 'lucide-react';
import { DEMO_LABEL, DEMO_NOTE } from '@/components/landing/demo/demo-script';
import { findScene, type SceneCard, type SceneLine } from '@/components/landing/preview-g/scenes';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import { cn } from '@/lib/utils';
import { CoachMark } from './CoachMark';
import { useScenePlayback, type Playback } from './use-scene-playback';
import styles from './scenes-i.module.css';

/**
 * Module 3's nine steps as conversations, with sample G's scripts (the same fictional beginner, no invented
 * numbers). Any step opens directly from the list (chips on a phone); the chosen step's icon gives a small wiggle.
 * The open conversation plays itself: the visitor's lines pop in, the coach thinks, types, and shows its card.
 * Every panel and every line is in the server HTML (inactive panels `hidden`), so the copy reads without
 * JavaScript; with reduced motion the conversation is simply shown in full.
 */

const ICONS: Record<string, LucideIcon> = {
  'step-chat': MessageCircle, 'step-truth': Compass, 'step-research': Search, 'step-report': FileText, 'step-library': BookOpen,
  'step-voice': PenLine, 'step-publish': Send, 'step-review': TrendingUp, 'step-fusion': Users,
};

export function ScenesI({ steps }: { steps: readonly FlowStep[] }) {
  const [active, setActive] = useState(0);
  const windowRef = useRef<HTMLDivElement>(null);
  const current = Math.min(active, Math.max(steps.length - 1, 0));
  const currentStep = steps[current];
  const lines = findScene(currentStep?.id ?? '')?.lines ?? NO_LINES;
  const { playback, replay } = useScenePlayback(lines, currentStep?.id ?? '', windowRef);
  if (steps.length === 0) return null;

  function select(index: number, focus = false) {
    setActive(index);
    if (focus) document.getElementById(`i-${steps[index].id}-tab`)?.focus();
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;
    event.preventDefault();
    select((current + (forward ? 1 : -1) + steps.length) % steps.length, true);
  }

  return (
    <div className={styles.scenes}>
      <div role="tablist" aria-label="九个场景" aria-orientation="vertical" className={styles.toc}>
        {steps.map((step, index) => {
          const Icon = ICONS[step.id] ?? Sparkles;
          return (
            <button key={step.id} id={`i-${step.id}-tab`} type="button" role="tab" aria-selected={index === current}
              aria-controls={`i-${step.id}-panel`} tabIndex={index === current ? 0 : -1}
              onClick={() => select(index)} onKeyDown={onKey}>
              <span className={styles.tocIcon} aria-hidden="true"><Icon size={16} strokeWidth={2.4} /></span>
              <span className={styles.tocTitle}>{step.title}</span>
            </button>
          );
        })}
      </div>

      {steps.map((step, index) => {
        const scene = findScene(step.id);
        const next = steps[(index + 1) % steps.length];
        const open = index === current;
        return (
          <div key={step.id} id={`i-${step.id}-panel`} role="tabpanel" aria-labelledby={`i-${step.id}-tab`}
            hidden={!open} className={styles.panel}>
            <div ref={open ? windowRef : undefined} className={styles.window}>
              <div className={styles.chrome}>
                <span className={styles.badge}>{DEMO_LABEL}</span>
                <span className={styles.chromeTitle}>{scene?.context ?? step.title}</span>
                {open ? (
                  <button type="button" className={styles.replay} onClick={replay}>
                    <RotateCcw size={14} aria-hidden="true" />重播
                  </button>
                ) : null}
              </div>
              <ol className={styles.log} aria-label={`${step.title}：示例对话`}>
                {(scene?.lines ?? []).map((line, order) => (
                  <Message key={order} line={line} order={order} playback={open ? playback : null} />
                ))}
              </ol>
              <p className={styles.disclaimer}>{DEMO_NOTE}</p>
            </div>

            <aside className={styles.aside}>
              <h3 className={styles.asideTitle}>
                <span aria-hidden="true">{index + 1}</span>{step.title}
              </h3>
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

const NO_LINES: readonly SceneLine[] = [];

/** One line. While its conversation plays, `playback` decides how much of it is drawn; the full text stays readable. */
function Message({ line, order, playback }: { line: SceneLine; order: number; playback: Playback }) {
  const coach = line.role === 'coach';
  const state = !playback || order < playback.index ? 'shown' : order > playback.index ? 'pending' : playback.phase;
  const typing = state === 'thinking' || state === 'typing';
  const showCard = line.card && (state === 'shown' || state === 'card');
  return (
    <li className={styles.message} data-role={line.role} data-state={state}>
      {coach ? <CoachMark className={styles.avatar} /> : null}
      <div className={styles.body}>
        <span className={styles.who}>{coach ? '教练' : '你'}</span>
        <div className={styles.bubble}>
          {state === 'thinking' ? (
            <span className={styles.dots} aria-hidden="true"><span /><span /><span /></span>
          ) : null}
          {typing ? (
            <p>
              <span aria-hidden="true">{line.text.slice(0, playback?.chars ?? 0)}<span className={styles.caret} /></span>
              <span className="sr-only">{line.text}</span>
            </p>
          ) : <p>{line.text}</p>}
          {line.card ? <div className={styles.cardSlot} data-on={Boolean(showCard)}><Card card={line.card} /></div> : null}
        </div>
      </div>
    </li>
  );
}

function Card({ card }: { card: SceneCard }) {
  if (card.type === 'options') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.question}</p>
        <ul className={styles.options}>
          {card.options.map((option, index) => (
            <li key={option} data-recommended={index === card.recommended}>
              <span>{option}</span>
              {index === card.recommended ? <span className={styles.tag}>推荐</span> : null}
            </li>
          ))}
          <li className={styles.optionOther}><span>其他，直接说你的情况</span></li>
        </ul>
        <p className={styles.reason}><Sparkles size={14} aria-hidden="true" />{card.reason}</p>
      </div>
    );
  }
  if (card.type === 'sheet') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.title}</p>
        <dl className={styles.sheet}>
          {card.rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        {card.action ? <span className={styles.cardAction}><Check size={14} aria-hidden="true" />{card.action}</span> : null}
      </div>
    );
  }
  if (card.type === 'table') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.title}</p>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr>{card.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>
              {card.rows.map(row => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (index === 0
                    ? <th key={index} scope="row">{cell}</th>
                    : <td key={index} data-missing={cell === '未取到'}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.caption}>{card.caption}</p>
      </div>
    );
  }
  if (card.type === 'chips') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.title}</p>
        <ul className={styles.chips}>{card.items.map(item => <li key={item}>{item}</li>)}</ul>
      </div>
    );
  }
  return (
    <div className={cn(styles.card, styles.doc)}>
      <p className={styles.cardTitle}>{card.title}</p>
      <ul className={styles.outline}>{card.items.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}
