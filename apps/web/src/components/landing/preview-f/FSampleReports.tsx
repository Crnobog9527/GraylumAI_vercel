/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type KeyboardEvent } from 'react';
import { SAMPLE_LABEL, SAMPLE_REPORTS_TITLE, SAMPLE_SECTIONS, type SampleReport } from '@/lib/landing/landing-samples';
import { cn } from '@/lib/utils';
import styles from './sample-f.module.css';

/** Module 3b in sample F: the same audience tabs and three fixed report parts as the landing page. */
export function FSampleReports({ reports }: { reports: readonly SampleReport[] }) {
  const [active, setActive] = useState(0);
  if (reports.length === 0) return null;
  const report = reports[Math.min(active, reports.length - 1)];

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (active + step + reports.length) % reports.length;
    setActive(next);
    document.getElementById(`f-${reports[next].id}-tab`)?.focus();
  }

  return (
    <div className={styles.samples}>
      <h3 className={styles.h3}>{SAMPLE_REPORTS_TITLE}</h3>
      <div role="tablist" aria-label={SAMPLE_REPORTS_TITLE} className={styles.tabs}>
        {reports.map((item, index) => (
          <button key={item.id} id={`f-${item.id}-tab`} type="button" role="tab" aria-selected={index === active}
            aria-controls={`f-${item.id}-panel`} tabIndex={index === active ? 0 : -1} className={styles.tab}
            onClick={() => setActive(index)} onKeyDown={onKey}>
            {item.audience}
          </button>
        ))}
      </div>
      <div id={`f-${report.id}-panel`} role="tabpanel" aria-labelledby={`f-${report.id}-tab`} className={styles.card}>
        <p className={styles.reportHead}>《运营策略报告》<span>{SAMPLE_LABEL}</span></p>
        <div className={styles.reportParts}>
          {SAMPLE_SECTIONS.map(section => {
            const paragraphs = report.sections[section.key].filter(paragraph => paragraph.trim());
            return (
              <section key={section.key} aria-label={section.title} className={styles.reportPart}>
                <p>{section.title}</p>
                {paragraphs.length > 0
                  ? paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)
                  : (
                    <div aria-hidden="true" className={cn(styles.placeholder)}>
                      {['88%', '72%', '56%'].map(width => <i key={width} style={{ width }} />)}
                    </div>
                  )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
