/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Bot, NotebookTabs } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import result from '@/components/opc/positioning-result.module.css';
import { QuestionCardView } from '@/components/opc/question-card';
import { H_COMPARE } from '@/lib/landing/landing-copy';
import { J_PERSONA_QUESTION, J_QUESTION_HEADING } from '@/lib/landing/landing-copy-j-persona';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import styles from './compare-j.module.css';
import page from './j.module.css';

/** Typing pace: how long each character takes, and the beats between the parts of one pair (milliseconds). */
const PER_CHAR = 22;
const ASKED = 300;
const BEAT = 500;

/** When each part of a pair plays: the question, the general AI's reply, then the coach's reply and its work. */
export function pairTiming(generic: string, coach: string) {
  const genericStart = ASKED + BEAT;
  const coachStart = genericStart + Array.from(generic).length * PER_CHAR + BEAT;
  const workAt = coachStart + Array.from(coach).length * PER_CHAR + 200;
  return { genericStart, coachStart, workAt };
}

/**
 * The Owner's four-row comparison as four pairs of real chat windows (Owner 2026-10-15, round five: "不够突出"). As each
 * pair scrolls in, the two windows slide in from their sides; the same question is sent to both; the general AI types
 * out its usual list, then the AI coach types its answer and its piece of work rises in under it. Each row's own words
 * (the Owner's) sit above its window. The windows are pictures (inert); the rows' text carries the meaning. The server
 * HTML and reduced motion show every reply in full.
 */
export function CompareJ() {
  const work: readonly ReactNode[] = [<Ask key="ask" />, <Plan key="plan" />, <Memory key="memory" />, <Review key="review" />];
  return (
    <section aria-labelledby="compare-title" className={page.section} data-zone="compare" data-band="ink">
      <div className={page.wrap}>
        <h2 id="compare-title" className={styles.title}>
          {H_COMPARE.title.split(/(?<=，)|(?=带你)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
        </h2>
        <ol className={styles.pairs}>
          {J_COMPARE.pairs.map((pair, index) => {
            const row = H_COMPARE.rows[index];
            const generic = pair.generic.join('\n');
            const timing = pairTiming(generic, pair.coach);
            return (
              <li key={pair.question} data-row="" className={styles.pair} style={{
                '--generic-at': `${timing.genericStart}ms`, '--coach-at': `${timing.coachStart}ms`, '--work-at': `${timing.workAt}ms`,
              } as CSSProperties}>
                <div className={styles.side} data-side="generic">
                  <p className={styles.claim}><b>{H_COMPARE.generic}</b>{row.generic}</p>
                  <Window name={J_COMPARE.genericName} question={pair.question} generic>
                    <div className={styles.genericReply}><Typed text={generic} start={timing.genericStart} /></div>
                  </Window>
                </div>
                <div className={styles.side} data-side="coach">
                  <p className={styles.claim}><b>{H_COMPARE.coach}</b>{row.coach}</p>
                  <Window name={J_COMPARE.coachName} question={pair.question}>
                    <div className={styles.coachReply}>
                      <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" />AI 自媒体陪跑教练</span>
                      <p><Typed text={pair.coach} start={timing.coachStart} /></p>
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

/** A reply typed out: every character on its own delay; the finished text takes its place from the start. */
function Typed({ text, start }: { text: string; start: number }) {
  return (
    <span className={styles.typed}>
      {Array.from(text).map((char, index) => (
        char === '\n' ? <br key={index} /> : <span key={index} style={{ '--d': `${start + index * PER_CHAR}ms` } as CSSProperties}>{char}</span>
      ))}
    </span>
  );
}

function Window({ name, question, generic = false, children }: {
  name: string; question: string; generic?: boolean; children: ReactNode;
}) {
  return (
    <div className={styles.window} data-generic={generic || undefined} inert aria-hidden="true">
      <p className={styles.bar}>
        <span className={styles.dots}><i /><i /><i /></span>
        {generic ? <Bot size={14} /> : <img src="/graylum-logo.png" alt="" />}<span>{name}</span>
        {generic ? null : <i className={styles.badge}>{DEMO_LABEL}</i>}
      </p>
      <div className={styles.chat}>
        <p className={styles.question}><span>你</span>{question}</p>
        {children}
      </div>
      <p className={styles.composer}>{generic ? '给通用 AI 发消息' : '和 AI 教练聊聊'}</p>
    </div>
  );
}

function Ask() {
  return <div className={styles.card}><QuestionCardView card={J_PERSONA_QUESTION} heading={J_QUESTION_HEADING} /></div>;
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
