/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { H_COMPARE } from '@/lib/landing/landing-copy';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import { K_COMPARE_PICKS } from '@/lib/landing/landing-copy-k';
import { CtaK } from './CtaK';
import styles from './k.module.css';

/**
 * Region 6, the comparison (Owner 2026-10-17, plan items 6 and 8): two of sample J's four pairs, the 穿搭博主 one first,
 * set as plain type — the question, then what a general AI says and what the coach says, each with its note. No chat
 * windows, nothing typed out; on a phone the two answers simply stack. Ends with the button.
 */
export function CompareK() {
  const pairs = K_COMPARE_PICKS.map(index => J_COMPARE.pairs[index]);
  return (
    <section aria-labelledby="compare-title" className={styles.section} data-zone="compare" data-region="对比区">
      <div className={styles.wrap}>
        <h2 id="compare-title" className={styles.minor}>{H_COMPARE.title}</h2>
        <ol className={styles.pairs}>
          {pairs.map(pair => (
            <li key={pair.question}>
              <p className={styles.asked}><span>你</span>{pair.question}</p>
              <div className={styles.answers}>
                <div data-side="generic">
                  <p className={styles.who}>{J_COMPARE.genericName}</p>
                  <p>{pair.generic.join('')}</p>
                  <p className={styles.verdict}><b>{J_COMPARE.genericNoteLabel}</b>{pair.genericNote}</p>
                </div>
                <div data-side="coach">
                  <p className={styles.who}>{J_COMPARE.coachName}</p>
                  <p>{pair.coach}</p>
                  <p className={styles.verdict}><b>{J_COMPARE.coachNoteLabel}</b>{pair.coachNote}</p>
                  <p className={styles.source}>{J_COMPARE.sourceLabel}：{pair.source}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <CtaK />
      </div>
    </section>
  );
}
