/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { DEMO_LABEL, DEMO_NOTE } from '@/components/landing/demo/demo-script';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import { cn } from '@/lib/utils';
import { findScene, type SceneCard, type SceneLine } from './scenes';
import styles from './scenes.module.css';

/**
 * Module 3's nine steps as conversations: a table of contents on the left (chips on a phone), one chat window per
 * step. Any step opens directly; the step's verbatim title, demo line and note sit beside its conversation.
 * Every panel is in the server HTML (inactive ones `hidden`), so all the copy is readable without JavaScript.
 * Messages arrive one by one when a panel opens; with reduced motion they are simply there.
 */
export function ScenesG({ steps }: { steps: readonly FlowStep[] }) {
  const [active, setActive] = useState(0);
  if (steps.length === 0) return null;
  const current = Math.min(active, steps.length - 1);

  function select(index: number, focus = false) {
    setActive(index);
    if (focus) document.getElementById(`g-${steps[index].id}-tab`)?.focus();
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
        {steps.map((step, index) => (
          <button key={step.id} id={`g-${step.id}-tab`} type="button" role="tab" aria-selected={index === current}
            aria-controls={`g-${step.id}-panel`} tabIndex={index === current ? 0 : -1}
            onClick={() => select(index)} onKeyDown={onKey}>
            <span className={styles.tocIndex} aria-hidden="true">{index + 1}</span>
            <span className={styles.tocTitle}>{step.title}</span>
          </button>
        ))}
      </div>

      {steps.map((step, index) => {
        const scene = findScene(step.id);
        const next = steps[(index + 1) % steps.length];
        return (
          <div key={step.id} id={`g-${step.id}-panel`} role="tabpanel" aria-labelledby={`g-${step.id}-tab`}
            hidden={index !== current} className={styles.panel}>
            <div className={styles.window}>
              <div className={styles.chrome}>
                <span className={styles.badge}>{DEMO_LABEL}</span>
                <span className={styles.chromeTitle}>{scene?.context ?? step.title}</span>
              </div>
              <ol className={styles.log} aria-label={`${step.title}：示例对话`}>
                {(scene?.lines ?? []).map((line, order) => (
                  <Message key={order} line={line} order={order} />
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

function Message({ line, order }: { line: SceneLine; order: number }) {
  const coach = line.role === 'coach';
  return (
    <li className={styles.message} data-role={line.role} style={{ '--i': order } as CSSProperties}>
      <span className={styles.who}>{coach ? '教练' : '你'}</span>
      <div className={styles.bubble}>
        <p>{line.text}</p>
        {line.card ? <Card card={line.card} /> : null}
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
