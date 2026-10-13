/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { RevealOnScroll } from '@/components/landing/offer/RevealOnScroll';
import { HOW_IT_WORKS, type GatedText } from '@/lib/landing/landing-copy';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import type { SampleReport } from '@/lib/landing/landing-samples';
import { cn } from '@/lib/utils';
import { FSampleReports } from './FSampleReports';
import styles from './sample-f.module.css';

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Module 3 in sample F: one colored panel. The clickable demo (the #893 component, same modules as the signed-in
 * conversation page) stays in view on wide screens while the walk-through steps scroll past it as stacked cards;
 * then the "what you get when" timeline and the sample reports. Copy and order are the landing page's.
 */
export function FHowItWorks({ promise, steps, timeline, reports }: {
  promise: readonly GatedText[];
  steps: readonly FlowStep[];
  timeline: readonly GatedText[];
  reports: readonly SampleReport[];
}) {
  return (
    <section id="how-it-works" aria-labelledby="f-how-title" className={cn(styles.panel, styles.deferred)}>
      <div className={styles.wrap}>
        <div className={styles.split}>
          <h2 id="f-how-title" className={styles.h2}>{HOW_IT_WORKS.title}</h2>
          <p className={styles.lede}>{promise.map(part => part.text).join('')}</p>
        </div>

        <div className={styles.workGrid}>
          <div className={styles.demoCol}><LazyDemo /></div>
          {steps.length > 0 ? (
            <RevealOnScroll>
              <ol className={styles.steps}>
                {steps.map((step, index) => (
                  <li key={step.id} id={step.id} data-reveal-row="" className={styles.step}>
                    <p className={styles.stepTop}>
                      <span className={styles.stepTag}>{pad(index + 1)}</span><span aria-hidden="true">/ {pad(steps.length)}</span>
                    </p>
                    <p className={styles.stepTitle}>{step.title}</p>
                    <p className={styles.stepDemo}>{step.demo}</p>
                    <p className={cn(styles.why, styles.later)}><b>{FLOW_NOTE_LABEL}</b>{step.note}</p>
                  </li>
                ))}
              </ol>
            </RevealOnScroll>
          ) : null}
        </div>

        {timeline.length > 0 ? (
          <>
            <h3 className={cn(styles.h3, styles.timelineTitle)}>{HOW_IT_WORKS.timelineTitle}</h3>
            <RevealOnScroll>
              <ol className={styles.timeline}>
                {timeline.map((item, index) => (
                  <li key={item.text} data-reveal-row="" className={styles.tick}>
                    <span aria-hidden="true" className={styles.tickNum}>{pad(index + 1)}</span>
                    <p className={styles.tickText}>{item.text}</p>
                  </li>
                ))}
              </ol>
            </RevealOnScroll>
          </>
        ) : null}

        <FSampleReports reports={reports} />
      </div>
    </section>
  );
}
