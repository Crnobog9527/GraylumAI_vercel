/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Bot } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import result from '@/components/opc/positioning-result.module.css';
import { H_COMPARE } from '@/lib/landing/landing-copy';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import styles from './compare-j.module.css';
import page from './j.module.css';

/** Typing pace: how long each character takes, and the beats between the parts of one pair (milliseconds). */
const PER_CHAR = 22;
const ASKED = 300;
const BEAT = 500;

/** When each part of a pair plays: the question, the general AI's reply, then the coach's reply. */
export function pairTiming(generic: string, coach: string, coachFirst = false) {
  const genericStart = ASKED + BEAT;
  // The coach that opens the conversation does not wait for a question, nor for the general AI.
  const coachStart = coachFirst ? BEAT : genericStart + Array.from(generic).length * PER_CHAR + BEAT;
  const done = coachStart + Array.from(coach).length * PER_CHAR;
  return { genericStart, coachStart, done };
}

/**
 * The comparison, plan A (Owner 2026-10-15): only how the two work differently, all four on one screen. Two chat
 * windows side by side, a general AI and the AI coach, each holding the same four exchanges; under each exchange
 * its window's own note (round seven: what the general AI gives you, how the coach differs), never one label for
 * both. As a row scrolls in, the question lands in both windows, the general AI types its
 * usual two lines, then the coach types its answer, its own words from a real sample conversation (named under it).
 * The windows are pictures (inert); the text carries the meaning. Server HTML and reduced motion show everything.
 * Sample L (Owner 2026-10-17): `title` replaces the heading, `picks` keeps only those pairs (by index), and `next` adds
 * a closing line to a pair's coach reply (by index): what the person does next. Samples M–O (Owner 2026-10-17, no dark
 * blocks): `band="tint"` sets it on the light band. Sample L (Owner 2026-10-17, demos as the real product): `steps` gives a
 * pair's coach head its step, as the positioning workspace writes it ("AI 自媒体陪跑教练 · 诊断与平台对标"); `after` sits under
 * the board. Sample L, round three (Owner 2026-10-17: the same task, what each one hands you): `pairs` replaces sample
 * J's pairs; a pair may carry its own coach `head` (the product's, for that kind of conversation) and a `verdict` under it.
 */
export function CompareJ({ title, picks, next, band = 'ink', steps, after, pairs }: {
  title?: string; picks?: readonly number[]; next?: Readonly<Record<number, string>>; band?: 'ink' | 'tint';
  steps?: Readonly<Record<number, string>>; after?: ReactNode; pairs?: readonly ComparePair[];
} = {}) {
  const all: readonly ComparePair[] = pairs ?? J_COMPARE.pairs;
  const shown = (picks ?? all.map((_, index) => index)).map(index => ({ pair: all[index], index }));
  return (
    <section aria-labelledby="compare-title" className={page.section} data-zone="compare" data-band={band} data-region="对比区">
      <div className={page.wrap}>
        <h2 id="compare-title" className={styles.title}>
          {(title ?? H_COMPARE.title).split(/(?<=，)|(?=带你)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
        </h2>
        <div className={styles.board}>
          <div className={styles.heads} aria-hidden="true">
            <WindowBar name={J_COMPARE.genericName} generic />
            <WindowBar name={J_COMPARE.coachName} />
          </div>
          <ol className={styles.pairs}>
            {shown.map(({ pair, index }) => {
              const generic = pair.generic.join('\n');
              const coach = next?.[index] ? `${pair.coach}\n\n${next[index]}` : pair.coach;
              const first = 'coachFirst' in pair && pair.coachFirst;
              const timing = pairTiming(generic, coach, first);
              return (
                <li key={pair.question} data-row="" className={styles.pair} data-region="对比卡片" style={{
                  '--generic-at': `${timing.genericStart}ms`, '--coach-at': `${timing.coachStart}ms`,
                } as CSSProperties}>
                  <div className={styles.cell} data-side="generic">
                    <div inert aria-hidden="true">
                      <p className={styles.mobileName}><Bot size={13} />{J_COMPARE.genericName}</p>
                      <p className={styles.question}><span>你</span>{pair.question}</p>
                      <div className={styles.genericReply}><Typed text={generic} start={timing.genericStart} /></div>
                    </div>
                    <p className={styles.note} data-side="generic"><b>{J_COMPARE.genericNoteLabel}</b>{pair.genericNote}</p>
                  </div>
                  <div className={styles.cell} data-side="coach">
                    <div inert aria-hidden="true">
                      {first ? null : <p className={styles.question}><span>你</span>{pair.question}</p>}
                      <div className={styles.coachReply}>
                        <span className={result.agentIdentity}>
                          <img src="/graylum-logo.png" alt="" />{pair.head ?? `AI 自媒体陪跑教练${steps?.[index] ? ` · ${steps[index]}` : ''}`}
                        </span>
                        <p><Typed text={coach} start={timing.coachStart} /></p>
                      </div>
                    </div>
                    <div className={styles.foot}>
                      <p className={styles.note} data-side="coach"><b>{J_COMPARE.coachNoteLabel}</b>{pair.coachNote}</p>
                      <p className={styles.source}>{J_COMPARE.sourceLabel}：{pair.source}</p>
                    </div>
                  </div>
                  {pair.verdict ? <p className={styles.verdict}>{pair.verdict}</p> : null}
                </li>
              );
            })}
          </ol>
        </div>
        {after}
      </div>
    </section>
  );
}

/** One exchange: the same question to a general AI and to the coach, each window's note, where the coach's words come from. */
export type ComparePair = {
  question: string; generic: readonly string[]; coach: string; genericNote: string; coachNote: string; source: string;
  coachFirst?: boolean; head?: string; verdict?: string;
};

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

function WindowBar({ name, generic = false }: { name: string; generic?: boolean }) {
  return (
    <p className={styles.bar} data-generic={generic || undefined}>
      <span className={styles.dots}><i /><i /><i /></span>
      {generic ? <Bot size={14} /> : <img src="/graylum-logo.png" alt="" />}<span>{name}</span>
      {generic ? null : <i className={styles.badge}>{DEMO_LABEL}</i>}
    </p>
  );
}
