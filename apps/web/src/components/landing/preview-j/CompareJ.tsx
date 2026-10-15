/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties } from 'react';
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
export function pairTiming(generic: string, coach: string) {
  const genericStart = ASKED + BEAT;
  const coachStart = genericStart + Array.from(generic).length * PER_CHAR + BEAT;
  const done = coachStart + Array.from(coach).length * PER_CHAR;
  return { genericStart, coachStart, done };
}

/**
 * The comparison, plan A (Owner 2026-10-15): only how the two work differently, all four on one screen. Two chat
 * windows side by side, a general AI and the AI coach, each holding the same four exchanges; the left column names
 * the difference each row shows. As a row scrolls in, the question lands in both windows, the general AI types its
 * usual two lines, then the coach types its answer, its own words from a real sample conversation (named under it).
 * The windows are pictures (inert); the text carries the meaning. Server HTML and reduced motion show everything.
 */
export function CompareJ() {
  return (
    <section aria-labelledby="compare-title" className={page.section} data-zone="compare" data-band="ink">
      <div className={page.wrap}>
        <h2 id="compare-title" className={styles.title}>
          {H_COMPARE.title.split(/(?<=，)|(?=带你)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
        </h2>
        <div className={styles.board}>
          <div className={styles.heads} aria-hidden="true">
            <span />
            <WindowBar name={J_COMPARE.genericName} generic />
            <WindowBar name={J_COMPARE.coachName} />
          </div>
          <ol className={styles.pairs}>
            {J_COMPARE.pairs.map(pair => {
              const generic = pair.generic.join('\n');
              const timing = pairTiming(generic, pair.coach);
              return (
                <li key={pair.theme} data-row="" className={styles.pair} style={{
                  '--generic-at': `${timing.genericStart}ms`, '--coach-at': `${timing.coachStart}ms`,
                } as CSSProperties}>
                  <p className={styles.theme}>{pair.theme}</p>
                  <div className={styles.cell} data-side="generic" inert aria-hidden="true">
                    <p className={styles.mobileName}><Bot size={13} />{J_COMPARE.genericName}</p>
                    <p className={styles.question}><span>你</span>{pair.question}</p>
                    <div className={styles.genericReply}><Typed text={generic} start={timing.genericStart} /></div>
                  </div>
                  <div className={styles.cell} data-side="coach">
                    <div inert aria-hidden="true">
                      <p className={styles.question}><span>你</span>{pair.question}</p>
                      <div className={styles.coachReply}>
                        <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" />AI 自媒体陪跑教练</span>
                        <p><Typed text={pair.coach} start={timing.coachStart} /></p>
                      </div>
                    </div>
                    <p className={styles.source}>{J_COMPARE.sourceLabel}：{pair.source}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
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

function WindowBar({ name, generic = false }: { name: string; generic?: boolean }) {
  return (
    <p className={styles.bar} data-generic={generic || undefined}>
      <span className={styles.dots}><i /><i /><i /></span>
      {generic ? <Bot size={14} /> : <img src="/graylum-logo.png" alt="" />}<span>{name}</span>
      {generic ? null : <i className={styles.badge}>{DEMO_LABEL}</i>}
    </p>
  );
}
