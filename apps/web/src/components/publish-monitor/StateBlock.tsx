/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import styles from './data-review.module.css';

/**
 * The empty, upgrade and failure states of the "数据复盘" page: what is the case in one sentence, then what to do next
 * (the buttons passed as children). A failure is announced (role="alert"); the others are plain content.
 */
export function StateBlock({ title, text, icon, tag, tone = 'plain', children }: { title: string; text: string;
  icon?: ReactNode; tag?: string; tone?: 'plain' | 'error'; children?: ReactNode }) {
  return (
    <div className={styles.state} data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <span className={styles.stateIcon}>{icon ?? <CircleAlert size={20} aria-hidden />}</span>
      {tag && <span className={styles.stateTag}>{tag}</span>}
      <h2>{title}</h2>
      <p>{text}</p>
      {children && <div className={styles.actions}>{children}</div>}
    </div>
  );
}
