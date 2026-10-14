/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import styles from './depth-motion.module.css';

/*
 * Text pieces for DepthStage pages. Both render the finished text in the server HTML: screen readers get it once
 * from a visually hidden copy, and the animated pieces are aria-hidden.
 */

/** Splits text into animation units: one per CJK character or punctuation mark, one per Latin word, spaces kept. */
export function splitUnits(text: string): string[] {
  return text.match(/[A-Za-z0-9$.,%+'’-]+|\s+|./gu) ?? [];
}

/** Most words this many units or shorter never break inside (a short CJK phrase wraps as one piece). */
const KEEP_TOGETHER = 8;

/**
 * A heading that rises in character by character. `load` plays once on first paint (pure CSS, for the first
 * screen); `reveal` plays when it scrolls into view (it is its own `data-reveal` element). Lines break at the
 * spaces of the text; a run longer than KEEP_TOGETHER may also break between characters.
 */
export function SplitText({ text, mode, className }: { text: string; mode: 'load' | 'reveal'; className?: string }) {
  let index = 0;
  const words = text.split(/(\s+)/).filter(Boolean);
  return (
    <span className={cn(styles.split, mode === 'load' ? styles.splitLoad : styles.splitReveal, className)}
      data-reveal={mode === 'reveal' ? '' : undefined}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, position) => {
          if (/^\s+$/.test(word)) return <span key={position}>{' '}</span>;
          const units = splitUnits(word);
          return (
            <span key={position} className={units.length <= KEEP_TOGETHER ? styles.word : undefined}>
              {units.map((unit, offset) => (
                <span key={offset} className={styles.ch} style={{ '--i': index++ } as CSSProperties}>{unit}</span>
              ))}
            </span>
          );
        })}
      </span>
    </span>
  );
}

/**
 * A price or number whose digits roll into place like an odometer when it scrolls into view, and roll to the new
 * value when it changes (monthly ↔ yearly). Only transform moves. Columns are keyed from the right so a changing
 * value keeps its columns and rolls instead of re-mounting.
 */
export function DigitRoll({ value, className }: { value: string; className?: string }) {
  const chars = Array.from(value);
  return (
    <span className={cn(styles.roll, className)} data-reveal="">
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className={styles.rollChars}>
        {chars.map((char, position) => {
          const fromRight = chars.length - position;
          if (!/\d/.test(char)) return <span key={`c${fromRight}`} className={styles.rollStatic}>{char}</span>;
          return (
            <span key={`d${fromRight}`} className={styles.col}>
              <span className={styles.strip} style={{ '--n': Number(char), '--k': position } as CSSProperties}>
                {DIGITS.map(digit => <span key={digit}>{digit}</span>)}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Class names for the plain-CSS motion pieces, for components that cannot import the stylesheet themselves. */
export const depthClass = {
  depth: styles.depth,
  depthSide: styles.depthSide,
  reveal: styles.reveal,
  tilt: styles.tilt,
  sheen: styles.sheen,
  parallax: styles.parallax,
  pop: styles.pop,
};
