/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import styles from './art-i.module.css';

/*
 * The first screen's illustration: a phone with a blank profile that fills in, post by post, while the coach
 * (the coral speech bubble from the backdrop) types beside it. The outlines draw themselves when the page opens,
 * then the posts pop in one by one, the question marks fade and a star appears, and the loop starts again.
 * With reduced motion the finished picture is shown and nothing moves. Decorative only (aria-hidden).
 */

const TILES = ['mint', 'coral', 'sun', 'lilac', 'sun', 'mint', 'coral', 'mint', 'lilac'] as const;

export function HeroArtI() {
  return (
    <svg viewBox="0 0 520 470" className={styles.art} aria-hidden="true" focusable="false">
      <ellipse cx="262" cy="446" rx="190" ry="16" className={styles.shadow} />
      <g className={styles.phone}>
        <rect x="150" y="30" width="224" height="404" rx="32" pathLength={1} className={styles.drawThick} />
        <path d="M232 52 h60" pathLength={1} className={styles.draw} />
        <circle cx="216" cy="102" r="28" pathLength={1} className={styles.avatar} />
        <path d="M256 92 h78 M256 112 h50" pathLength={1} className={styles.draw} />
        {[176, 238, 300].map(x => <rect key={x} x={x} y="146" width="46" height="12" rx="6" className={styles.stat} />)}
        {TILES.map((color, index) => {
          const x = 172 + (index % 3) * 62;
          const y = 176 + Math.floor(index / 3) * 62;
          return (
            <g key={index}>
              <rect x={x} y={y} width="56" height="56" rx="10" className={styles.slot} />
              <rect x={x} y={y} width="56" height="56" rx="10" className={styles[`${color}Tile`]}
                style={{ '--n': index } as CSSProperties} />
            </g>
          );
        })}
        <path d="M232 410 h60" pathLength={1} className={styles.draw} />
      </g>

      <g className={styles.doubt}>
        <path d="M66 112 Q68 92 86 94 Q102 98 92 114 Q84 122 84 134 M84 150 v1" className={styles.ink} />
        <path d="M108 186 Q109 172 121 173 Q132 176 125 187 Q119 192 119 200 M119 212 v1" className={styles.ink} />
      </g>
      <path d="M86 132 l7 -17 l7 17 l17 7 l-17 7 l-7 17 l-7 -17 l-17 -7 Z" className={styles.star} />

      <g transform="translate(430 330)">
        <g className={styles.coach}>
          <path d="M-46 0 C-46 -36 -24 -54 0 -54 C24 -54 46 -36 46 0 C46 30 24 46 0 46 L-16 46 L-34 64 L-30 40
            C-40 32 -46 18 -46 0 Z" pathLength={1} className={styles.coachBody} />
          <circle cx="-15" cy="-6" r="5.5" className={styles.eye} />
          <circle cx="15" cy="-6" r="5.5" className={styles.eye} />
          <path d="M-11 14 Q0 23 11 14" className={styles.ink} />
        </g>
      </g>
      <g className={styles.bubble}>
        <rect x="372" y="186" width="104" height="52" rx="22" className={styles.bubbleBody} />
        {[402, 424, 446].map((cx, index) => (
          <circle key={cx} cx={cx} cy="212" r="6" className={styles.typing} style={{ '--n': index } as CSSProperties} />
        ))}
      </g>
      <path d="M450 112 l5 -12 l5 12 l12 5 l-12 5 l-5 12 l-5 -12 l-12 -5 Z" className={styles.twinkle} />
      <path d="M40 300 l4 -10 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 Z" className={styles.twinkleLate} />
    </svg>
  );
}
