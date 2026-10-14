/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties, ReactNode } from 'react';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import { Button } from '@/components/ui/button';
import result from '@/components/opc/positioning-result.module.css';
import {
  DEMO_LABEL, DEMO_STEPS, REPORT_TITLE, demoInformation, demoReducer, summaryDemoState,
} from '@/components/landing/demo/demo-script';
import { depthClass } from '@/components/public-site/motion/depth-text';
import { cn } from '@/lib/utils';
import styles from './hero-h.module.css';

const noop = () => undefined;
/** The demo case once its first step is confirmed: what the floating checklist and summary show. */
const confirmed = demoReducer(demoReducer(summaryDemoState(), { type: 'settled' }), { type: 'confirm' });
const summary = confirmed.messages.at(-1);
const field = (id: string) => confirmed.values[id]?.value ?? '';

/**
 * The real product pieces that float around the first screen's text, like the icons around Buffer's hero: the
 * positioning steps with the first one done, the step summary, the confirmed positioning checklist and the report
 * (the mentor's question card is already in the exchange beside the difference line). All come from
 * the landing demo's made-up case (示例), rendered with the workbench's own components and styles; decorative for
 * assistive tech (the same content is in the demo below). Each drifts at its own speed as the page scrolls.
 */
export function HeroFloatsH() {
  return (
    <div className={styles.floats} aria-hidden="true">
      <Float slot="steps" speed={0.55}>
        <div className={styles.steps}>
          <p className={styles.stepsHead}><span>我的定位分析</span><small>整体规划 · 第一步已确认</small></p>
          <div className={styles.stepsStrip}>
            {DEMO_STEPS.map((step, index) => (
              <Button key={step.id} variant={index === 0 ? 'default' : 'outline'} size="sm" tabIndex={-1}>
                {index === 0 ? '✓ ' : `${index + 1} `}{step.title}
              </Button>
            ))}
          </div>
        </div>
      </Float>
      <Float slot="summary" speed={1.05}>
        <div data-message-role="assistant" className={styles.message}>
          <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" width={22} height={22} />{summary?.label}</span>
          <p className={styles.messageTitle}>本步小结</p>
          <ul className={styles.messageList}>
            <li>可以讲的经验：{field('experience')}</li>
            <li>每周能投入的时间：{field('time')}</li>
            <li>想帮的人：{field('audience')}</li>
          </ul>
        </div>
      </Float>
      <Float slot="checklist" speed={0.8}>
        <div className={cn(result.panel, styles.checklist)}>
          <header><h2>定位清单</h2></header>
          <div className={result.body}>
            <CaptureChecklist steps={DEMO_STEPS.slice(0, 1)} information={demoInformation(confirmed)} valid={{ you: true }}
              edits={{}} selectedStepId="you" editable={false} manual={false} locked confirmable={() => false}
              confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null} onEdit={noop} onComposition={noop}
              onResolve={noop} onReview={noop} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
          </div>
        </div>
      </Float>
      <Float slot="report" speed={1.25}>
        <div className={styles.report}>
          <p className={styles.reportTitle}>{REPORT_TITLE}</p>
          <p className={styles.reportHeading}>一句话定位</p>
          <p className={styles.reportText}>帮刚到加拿大的新移民，用下班时间一步步转行做牙科助理。</p>
          <p className={styles.reportHeading}>第一个 30 天计划</p>
          <p className={styles.reportText}>第 1 周：讲清你自己是怎么入行的</p>
        </div>
      </Float>
    </div>
  );
}

function Float({ slot, speed, children }: { slot: string; speed: number; children: ReactNode }) {
  return (
    <div className={cn(styles.float, depthClass.parallax)} data-slot={slot} style={{ '--speed': speed } as CSSProperties}>
      <div className={styles.floatCard}>
        <span className={styles.sample}>{DEMO_LABEL}</span>
        {children}
      </div>
    </div>
  );
}
