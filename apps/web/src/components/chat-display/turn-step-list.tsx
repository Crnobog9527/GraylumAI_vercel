'use client';
import { useState } from 'react';
import { Check, ChevronDown, Loader2, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stepLine, stepsOpen, stepsSummary, visibleSteps, type ReplyStep } from './turn-step-list-model';
import styles from './turn-step-list.module.css';

/**
 * The steps of one reply, above its text, in every conversation that shows them (usage: docs/launch/tasks/TURN-STEP-LIST.md).
 * While the reply is live and nothing is written, the list is open and its last line is "正在思考…" or the running step; once the
 * text flows, and after the reply ended, it folds into "已完成 N 个步骤" which opens on a click. Display only: the steps come in
 * as props, from the stream (`mergeStep`) or from what a reload read back.
 *  - `steps`: the steps so far, in order.
 *  - `live`: this reply is being written now (false for a reply read back from history).
 *  - `hasText`: some of its text has arrived.
 */
export function TurnStepList({ steps, live = false, hasText = false }: { steps: readonly ReplyStep[]; live?: boolean; hasText?: boolean }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const shown = visibleSteps(steps, live, hasText);
  if (!shown.length) return null;
  const open = stepsOpen(steps, live, hasText, chosen);
  if (!open) {
    return (
      <div className={styles.wrap} data-turn-step-list="folded">
        <button type="button" className={styles.fold} aria-expanded={false} onClick={() => setChosen(true)}>
          <Check aria-hidden size={14} className={cn(styles.icon, styles.done)} style={{ marginTop: 0 }}/>
          <span className={styles.text}>{stepsSummary(steps)}</span>
          <ChevronDown aria-hidden size={14} className={styles.chevron}/>
        </button>
      </div>
    );
  }
  return (
    <div className={styles.wrap} data-turn-step-list="open">
      {!live && (
        <button type="button" className={styles.fold} aria-expanded onClick={() => setChosen(false)}>
          <span className={styles.text}>{stepsSummary(steps)}</span>
          <ChevronDown aria-hidden size={14} className={styles.chevron}/>
        </button>
      )}
      <ul role="status" aria-live="polite" aria-relevant="additions text" aria-atomic="false" aria-label="这条回复的步骤"
        className={cn(styles.list, !live && styles.opened)}>
        {shown.map(step => {
          const running = step.state === 'running';
          const Icon = running ? Loader2 : step.state === 'done' ? Check : Minus;
          return (
            <li key={step.id} className={styles.row} data-step-state={step.state} data-step-tool={step.tool}>
              <Icon aria-hidden size={14} className={cn(styles.icon, step.state === 'done' && styles.done,
                running && (step.tool === 'think' ? styles.pulse : styles.spin))}/>
              <span className={styles.text}>{stepLine(step)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
