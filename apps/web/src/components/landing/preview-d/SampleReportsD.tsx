/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type KeyboardEvent } from 'react';
import { SAMPLE_LABEL, SAMPLE_REPORTS_TITLE, SAMPLE_SECTIONS, type SampleReport } from '@/lib/landing/landing-samples';
import { Phrases } from './Phrases';
import styles from './d.module.css';

/**
 * Module 3b in sample D: audience tabs as pills, the report as a white sheet. Same data and behavior as the
 * landing page's SampleReports (a report not generated yet shows grey placeholder lines).
 */
export function SampleReportsD({ reports }: { reports: readonly SampleReport[] }) {
  const [active, setActive] = useState(0);
  if (reports.length === 0) return null;
  const report = reports[Math.min(active, reports.length - 1)];

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (active + step + reports.length) % reports.length;
    setActive(next);
    document.getElementById(`d-${reports[next].id}-tab`)?.focus();
  }

  return (
    <div className={styles.reports}>
      <h3 className={styles.displaySmall}><Phrases text={SAMPLE_REPORTS_TITLE} /></h3>
      <div role="tablist" aria-label={SAMPLE_REPORTS_TITLE} className={styles.reportTabs}>
        {reports.map((item, index) => (
          <button key={item.id} id={`d-${item.id}-tab`} type="button" role="tab" aria-selected={index === active}
            aria-controls={`d-${item.id}-panel`} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)} onKeyDown={onKey}>
            {item.audience}
          </button>
        ))}
      </div>
      <div id={`d-${report.id}-panel`} role="tabpanel" aria-labelledby={`d-${report.id}-tab`} className={styles.reportSheet}>
        <p className={styles.reportHead}>《运营策略报告》<span>{SAMPLE_LABEL}</span></p>
        {SAMPLE_SECTIONS.map(section => {
          const paragraphs = report.sections[section.key].filter(paragraph => paragraph.trim());
          return (
            <section key={section.key} aria-label={section.title} className={styles.reportPart}>
              <p className={styles.reportPartTitle}>{section.title}</p>
              {paragraphs.length > 0
                ? paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)
                : (
                  <div aria-hidden="true" className={styles.reportLines}>
                    {['85%', '70%', '55%'].map(width => <span key={width} style={{ width }} />)}
                  </div>
                )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
