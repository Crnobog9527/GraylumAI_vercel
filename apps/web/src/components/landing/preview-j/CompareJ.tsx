/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { ReactNode } from 'react';
import { Bot, NotebookTabs, Sparkles } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { QuestionCardView } from '@/components/opc/question-card';
import { H_COMPARE } from '@/lib/landing/landing-copy';
import { J_PERSONA_QUESTION } from '@/lib/landing/landing-copy-j-persona';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import styles from './compare-j.module.css';
import page from './j.module.css';

/**
 * The Owner's four-row comparison as four pairs of conversations (Owner 2026-10-15): one question, asked of a
 * general AI on the left and of the AI coach on the right. The left gets the usual list of everything; the right
 * gets the coach's work — the question card, a decided topic with why and how, its memory of you, a read of the
 * real data. Each row's own words (the Owner's) sit above its pair. The windows are pictures (inert); the rows'
 * text carries the meaning.
 */
export function CompareJ() {
  const work: readonly ReactNode[] = [<Ask key="ask" />, <Plan key="plan" />, <Memory key="memory" />, <Review key="review" />];
  return (
    <section aria-labelledby="compare-title" className={page.section} data-zone="compare">
      <div className={page.wrap}>
        <h2 id="compare-title" className={styles.title}>
          {H_COMPARE.title.split(/(?<=，)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
        </h2>
        <ol className={styles.pairs}>
          {J_COMPARE.pairs.map((pair, index) => {
            const row = H_COMPARE.rows[index];
            return (
              <li key={pair.question} data-row="" className={styles.pair}>
                <div className={styles.side} data-side="generic">
                  <p className={styles.claim}><b>{H_COMPARE.generic}</b>{row.generic}</p>
                  <Window name={J_COMPARE.genericName} question={pair.question} generic>
                    <div className={styles.genericReply}>{pair.generic.map(line => <p key={line}>{line}</p>)}</div>
                  </Window>
                </div>
                <div className={styles.side} data-side="coach">
                  <p className={styles.claim}><b>{H_COMPARE.coach}</b>{row.coach}</p>
                  <Window name={J_COMPARE.coachName} question={pair.question}>
                    <div className={styles.coachReply}>
                      <p>{pair.coach}</p>
                      <div className={styles.work}>{work[index]}</div>
                    </div>
                  </Window>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function Window({ name, question, generic = false, children }: {
  name: string; question: string; generic?: boolean; children: ReactNode;
}) {
  return (
    <div className={styles.window} data-generic={generic || undefined} inert aria-hidden="true">
      <p className={styles.bar}>
        {generic ? <Bot size={14} /> : <Sparkles size={14} />}<span>{name}</span>
        {generic ? null : <i>{DEMO_LABEL}</i>}
      </p>
      <p className={styles.question}>{question}</p>
      {children}
    </div>
  );
}

function Ask() {
  return <div className={styles.card}><QuestionCardView card={J_PERSONA_QUESTION} /></div>;
}
function Plan() {
  return <Sheet title={J_COMPARE.pairs[1].plan.title} rows={J_COMPARE.pairs[1].plan.rows} />;
}
function Memory() {
  return (
    <div className={styles.sheet}>
      <p className={styles.sheetTitle}><NotebookTabs size={14} />资料库</p>
      <dl>{J_COMPARE.pairs[2].memory.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
    </div>
  );
}
function Review() {
  return <Sheet title={J_COMPARE.pairs[3].review.title} rows={J_COMPARE.pairs[3].review.rows} />;
}
function Sheet({ title, rows }: { title: string; rows: readonly (readonly [string, string])[] }) {
  return (
    <div className={styles.sheet}>
      <p className={styles.sheetTitle}>{title}</p>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </div>
  );
}
