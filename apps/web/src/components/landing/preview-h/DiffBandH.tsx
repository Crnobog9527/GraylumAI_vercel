/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { depthClass } from '@/components/public-site/motion/depth-text';
import { H_COMPARE, HERO_H } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import styles from './h.module.css';
import hero from './hero-h.module.css';

/**
 * The second screen, right under the full-screen first one: the product at work first (the real conversation
 * components, opening on the step summary and confirming the step), then why a coach and not a general AI — the
 * Owner's difference body beside four rows of "自己用通用 AI ／ 用教练" (below it on a phone).
 */
export function DiffBandH() {
  return (
    <section aria-label={H_COMPARE.caption} className={cn(styles.section, hero.band)}>
      <div className={styles.demoFrame}><LazyDemo start="summary" /></div>
      <div className={hero.diff}>
        <p className={hero.diffBody}>{HERO_H.differenceBody}</p>
        <table className={cn(hero.table, styles.glass)}>
          <caption className="sr-only">{H_COMPARE.caption}</caption>
          <thead>
            <tr><th scope="col">{H_COMPARE.generic}</th><th scope="col">{H_COMPARE.coach}</th></tr>
          </thead>
          <tbody>
            {H_COMPARE.rows.map((row, index) => (
              <tr key={row.coach} data-reveal="" className={depthClass.reveal} style={{ '--d': index } as CSSProperties}>
                <td>{row.generic}</td>
                <td>{row.coach}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
