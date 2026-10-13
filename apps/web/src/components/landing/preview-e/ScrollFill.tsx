/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import styles from './e.module.css';

// The fill runs over this part of the paragraph's pass through the viewport (CSS `cover` range).
const FROM = 18;
const SPAN = 42;

/**
 * A paragraph whose characters turn from grey to ink as it scrolls past (ploy's reading fill), with CSS only:
 * each character gets its own slice of the paragraph's view timeline. Screen readers and search engines get the
 * plain sentence once; the split copy is hidden from them. Without scroll timelines or with reduced motion the
 * text is simply ink.
 */
export function ScrollFill({ text }: { text: string }) {
  const chars = Array.from(text);
  const step = SPAN / Math.max(chars.length, 1);
  return (
    <p className={styles.fill}>
      <span className="sr-only">{text}</span>
      {chars.map((char, index) => {
        const start = FROM + index * step;
        const style = { '--a': `${start.toFixed(2)}%`, '--b': `${(start + 4).toFixed(2)}%` } as CSSProperties;
        return <span key={index} aria-hidden="true" style={style}>{char}</span>;
      })}
    </p>
  );
}
