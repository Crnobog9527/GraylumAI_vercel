/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Check, Loader2 } from 'lucide-react';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { DEMO_LABEL, DEMO_STEPS, demoInformation, summaryDemoState, type DemoState } from '@/components/landing/demo/demo-script';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { Button } from '@/components/ui/button';
import { J_POSITIONING_SAMPLE, J_TAKEOVER } from '@/lib/landing/landing-copy-j';
import { cn } from '@/lib/utils';
import styles from './takeover-j.module.css';

const noop = () => undefined;
type Line = { id: string; role: 'user' | 'assistant'; label: string; text: string };


// The first phase is the demo's own script up to its summary; the second and third continue the same made-up case.
const summary = summaryDemoState();
const YOU: Line[] = summary.messages.map(message => ({ ...message }));
const DIRECTION: Line[] = [
  { id: 'd1', role: 'assistant', label: '导师 · 方向判断', text: J_POSITIONING_SAMPLE.directionReply },
  { id: 'd2', role: 'assistant', label: '教练的提醒 · 方向判断', text: J_POSITIONING_SAMPLE.reminder },
];
const BENCHMARK: Line[] = [{ id: 'b1', role: 'assistant', label: '导师 · 找对标', text: J_TAKEOVER.benchmarkLine }];
const PHASES = [YOU, DIRECTION, BENCHMARK];

/** The checklist's values at each phase: phase 2 adds the direction, phase 3 the benchmark accounts. */
function stateAt(phase: number): DemoState {
  const captured = (value: string) => ({ value, status: 'confirmed' as const, nature: 'fact' as const });
  const values = { ...summary.values };
  if (phase >= 1) Object.assign(values, { direction: captured(J_POSITIONING_SAMPLE.direction), risk: captured(J_POSITIONING_SAMPLE.reminder) });
  if (phase >= 2) Object.assign(values, { accounts: captured(J_POSITIONING_SAMPLE.benchmarkKinds.join('、')) });
  return { ...summary, values };
}

/**
 * The free positioning analysis, played by the scroll: the real workbench (step strip, conversation, checklist)
 * goes through 你是谁 → 方向判断 → 找对标, each phase's messages arriving and the checklist filling and confirming.
 * In 找对标 the coach fetches the benchmark accounts' public data (no numbers are shown). `progress` is 0 → 1.
 */
export function PositioningClipJ({ progress }: { progress: number }) {
  const phase = Math.min(2, Math.floor(progress * 3));
  const local = Math.min(1, progress * 3 - phase);
  const lines = PHASES[phase];
  // What has arrived so far in this phase; the window keeps the last four in view, like a scrolled log.
  const visible = lines.slice(0, Math.max(1, Math.ceil(local * lines.length * 1.25))).slice(-4);
  const state = stateAt(phase);
  const valid = Object.fromEntries(DEMO_STEPS.map((step, index) => [step.id, index < phase || (index === phase && local > .85)]));
  const fetched = phase === 2 ? Math.floor(Math.max(0, local - .25) / .2) : 0;
  return (
    <div className={styles.window}>
      <div className={styles.windowBar}><span className={styles.sample}>{DEMO_LABEL}</span><b>我的定位分析</b></div>
      <div className={styles.strip}>
        {DEMO_STEPS.map((step, index) => (
          <Button key={step.id} size="sm" variant={index === phase ? 'default' : 'outline'} tabIndex={-1}>
            {valid[step.id] ? '✓ ' : `${index + 1} `}{step.title}
          </Button>
        ))}
      </div>
      <div className={styles.panes}>
        <div className={styles.log}>
          {visible.map(line => (
            <div key={line.id} data-message-role={line.role} className={line.role === 'user' ? styles.user : styles.coach}>
              <span className={result.agentIdentity}>{line.label}</span>
              <MessageMarkdown className={styles.messageText} text={line.text} />
            </div>
          ))}
          {phase === 2 ? (
            <ul className={styles.fetch}>
              {J_POSITIONING_SAMPLE.benchmarkKinds.map((kind, index) => (
                <li key={kind} data-done={index < fetched || undefined}>
                  {index < fetched ? <Check size={15} aria-hidden="true" /> : <Loader2 size={15} aria-hidden="true" />}
                  {kind}<span>{index < fetched ? '已取到公开数据' : '正在抓取'}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className={cn(result.panel, styles.checklist)}>
          <header><h2>定位清单</h2></header>
          <div className={result.body}>
            <CaptureChecklist steps={DEMO_STEPS} information={demoInformation(state)} valid={valid} edits={{}}
              selectedStepId={DEMO_STEPS[phase].id} editable={false} manual={false} locked confirmable={() => false}
              confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null} onEdit={noop} onComposition={noop}
              onResolve={noop} onReview={noop} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
          </div>
        </div>
      </div>
    </div>
  );
}
