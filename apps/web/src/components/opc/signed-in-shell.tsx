/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './signed-in-shell.module.css';

/**
 * What a signed-in page shows before its scripts have taken over: the same frame as the workspace (top bar, side column, conversation
 * area with the input box at the bottom), with no data in it. Static (no hooks, no data), so the server's HTML and the browser's first
 * render are the same markup.
 */
export function SignedInShell() {
  return (
    <div className={styles.frame} aria-hidden="true" data-testid="signed-in-shell">
      <div className={styles.top}>Graylum</div>
      <div className={styles.body}>
        <div className={styles.rail} />
        <div className={styles.main}><div className={styles.composer} /></div>
      </div>
    </div>
  );
}
