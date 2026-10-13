/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type KeyboardEvent } from 'react';
import { SAMPLE_LABEL, SAMPLE_REPORTS_TITLE, SAMPLE_SECTIONS, type SampleReport } from '@/lib/landing/landing-samples';
import styles from './e.module.css';

/**
 * Module 3b in this sample's look: audience tabs, one sample report per tab, the same three parts and wording as
 * the landing page's SampleReports. Shown only once real reports exist (landing-flags.ts).
 */
export function ESampleReports({ reports }: { reports: readonly SampleReport[] }) {
  const [active, setActive] = useState(0);
  if (reports.length === 0) return null;
  const report = reports[Math.min(active, reports.length - 1)];

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (active + step + reports.length) % reports.length;
    setActive(next);
    document.getElementById(`e-${reports[next].id}-tab`)?.focus();
  }

  return (
    <div className={styles.samples}>
      <h3 className={styles.h3}>{SAMPLE_REPORTS_TITLE}</h3>
      <div role="tablist" aria-label={SAMPLE_REPORTS_TITLE} className={styles.tabs}>
        {reports.map((item, index) => (
          <button key={item.id} id={`e-${item.id}-tab`} type="button" role="tab" aria-selected={index === active}
            aria-controls={`e-${item.id}-panel`} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)} onKeyDown={onKey}
            className={styles.tab}>
            {item.audience}
          </button>
        ))}
      </div>
      <div id={`e-${report.id}-panel`} role="tabpanel" aria-labelledby={`e-${report.id}-tab`} className={styles.report}>
        <p className={styles.reportHead}>《运营策略报告》<span className={styles.tag}>{SAMPLE_LABEL}</span></p>
        {SAMPLE_SECTIONS.map(section => {
          const paragraphs = report.sections[section.key].filter(paragraph => paragraph.trim());
          return (
            <section key={section.key} aria-label={section.title} className={styles.reportPart}>
              <p>{section.title}</p>
              {paragraphs.length > 0
                ? paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)
                : <div aria-hidden="true" className={styles.placeholder}>{['85%', '70%', '55%'].map(width => <span key={width} style={{ width }} />)}</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
