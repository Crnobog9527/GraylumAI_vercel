/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { STEP_TEXT } from './jury-eta';
import { STAGES, stageIndex, type StageKey } from './jury-scenes';
import styles from './jury-layout.module.css';

/**
 * The eight steps down the left side: what each does and why, the current one lit with the time left. A step lights
 * only once the canvas shows it; skipped steps say so. On a phone it shrinks to one line on top. In the prototype a
 * step can be clicked to jump there; the real page plays only what has arrived.
 */
export function JuryStepsRail({ stage, skipped, ended, left, onJump }: {
  stage: StageKey | null; skipped: readonly StageKey[]; ended: boolean; left: string; onJump?: (stage: StageKey) => void;
}) {
  const current = stage ? stageIndex(stage) : -1;
  return (
    <nav className={styles.steps} aria-label="评审进度">
      <p className={styles.stepsNow}>
        <span>{ended ? '评审完成' : current >= 0 ? <>第 {current + 1} 步/共 8 步：<b>{STAGES[current].label}</b></> : '等待开始'}</span>
        {ended ? null : <span>{left}</span>}
      </p>
      <ol>
        {STAGES.map((item, index) => {
          const skip = skipped.includes(item.key);
          const state = skip ? 'skipped' : ended || index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li key={item.key} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <button type="button" disabled={!onJump || skip} onClick={() => onJump?.(item.key)} title={`跳到「${item.label}」（原型）`}>
                <span className={styles.stepDot} aria-hidden="true" />
                <span className={styles.stepBody}>
                  <span className={styles.stepLabel}>
                    {item.label}{skip ? <small>没有分歧，跳过</small> : null}
                    {state === 'current' && !ended ? <small className={styles.stepLeft}>{left}</small> : null}
                  </span>
                  <span className={styles.stepWhat}>{STEP_TEXT[item.key].what}</span>
                  <span className={styles.stepWhy}>{STEP_TEXT[item.key].why}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
