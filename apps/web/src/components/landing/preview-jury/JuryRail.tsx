/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { STAGES, stageIndex, type StageKey } from './jury-scenes';
import styles from './jury.module.css';

/**
 * The overall progress: eight stations on a track. A station lights only once the stage shows it, and the fill
 * follows the stations passed, never time; there is no fake percentage. In the prototype a station can be clicked
 * to jump there; the real page plays only what has arrived.
 */
export function JuryRail({ stage, skipped, ended, onJump }: {
  stage: StageKey | null; skipped: readonly StageKey[]; ended: boolean; onJump?: (stage: StageKey) => void;
}) {
  const current = stage ? stageIndex(stage) : -1;
  const fill = ended ? 1 : Math.max(0, current) / (STAGES.length - 1);
  return (
    <nav aria-label="评审进度" className={styles.rail}>
      <p className={styles.railNow}>
        {ended ? '评审完成' : current >= 0 ? <>第 {current + 1} 步，共 8 步：<strong>{STAGES[current].label}</strong></> : '等待开始'}
      </p>
      <div className={styles.track} aria-hidden="true"><span style={{ transform: `scaleX(${fill})` }} /></div>
      <ol>
        {STAGES.map((item, index) => {
          const skip = skipped.includes(item.key);
          const state = skip ? 'skipped' : ended || index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li key={item.key} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <button type="button" className={styles.railStop} disabled={!onJump || skip}
                onClick={() => onJump?.(item.key)} title={`跳到「${item.label}」（原型）`}>
                <span className={styles.railDot} aria-hidden="true" />
                <span className={styles.railLabel}>{item.label}{skip ? <small>没有分歧，跳过</small> : null}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
