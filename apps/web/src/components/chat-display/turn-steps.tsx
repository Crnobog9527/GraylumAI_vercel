/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useState } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { REOPENED_HINT, slowHint, turnSteps, type TurnProgressInput } from './turn-steps-model';
import styles from './turn-steps.module.css';

/**
 * The small steps of one running turn: each action gets a line with a light spinner while it runs and a tick once done,
 * so a 70–85 second turn never looks like one frozen "生成中". `reopened` is a turn this page did not start (after a
 * reload): it shows the same steps with a note that the page keeps updating by itself. Display only.
 */
export function TurnSteps({ progress, reopened = false, hideTools = false, quiet = false }: {
  progress: TurnProgressInput; reopened?: boolean;
  /** The caller already lists every tool call as its own row (the work conversation); skip the summary line. */
  hideTools?: boolean;
  /** No timed or reopened hint: the caller's own notices already tell the user what to do. */
  quiet?: boolean;
}) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 5000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const steps = turnSteps(progress).filter(step => !(hideTools && step.id === 'tools'));
  const hint = quiet ? null : reopened ? REOPENED_HINT : slowHint(elapsed);
  return (
    <div data-turn-steps>
      <ul role="status" aria-live="polite" aria-atomic="false" aria-label="这一轮的进度" className={styles.list}>
        {steps.map(step => {
          const Icon = step.state === 'running' ? Loader2 : step.state === 'done' ? Check : Circle;
          return (
            <li key={step.id} className={styles.row} data-step={step.id} data-step-state={step.state}>
              <Icon aria-hidden size={14}
                className={cn(styles.icon, step.state === 'running' && styles.spin, step.state === 'done' && styles.done)}/>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ul>
      {hint && <p className={styles.hint} data-turn-hint>{hint}</p>}
    </div>
  );
}
