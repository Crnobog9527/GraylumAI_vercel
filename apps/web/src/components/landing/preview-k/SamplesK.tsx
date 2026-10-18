/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { FileText } from 'lucide-react';
import { FullReport, Glance } from '@/components/landing/preview-j/SamplesJ';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { K_SAMPLES_BRIDGE } from '@/lib/landing/landing-copy-k';
import { SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { CtaK } from './CtaK';
import styles from './k.module.css';

/**
 * Region 4, the sample reports (Owner 2026-10-17, plan item 4): the four groups as tabs and, for the one picked, only
 * the cover and its 10-second card; nothing plays by itself. The whole report waits behind "看完整报告". It opens on
 * "换成你，会是这样" and closes with the button. The caller shows it only in a local preview or behind the flag.
 */
export function SamplesK() {
  const [active, setActive] = useState(0);
  const report = J_SAMPLES.reports[active];
  const data = SAMPLE_CHAPTERS[report.slug];
  return (
    <section aria-labelledby="samples-title" className={styles.section} data-zone="takeover" data-region="样例报告">
      <div className={styles.wrap}>
        <div className={styles.samplesHead}>
          <p className={styles.bridge}>{K_SAMPLES_BRIDGE}</p>
          <h2 id="samples-title" className={styles.lead}>{J_SAMPLES.title}</h2>
        </div>
        <div role="tablist" aria-label="样例报告" className={samples.tabs}>
          {J_SAMPLES.reports.map((item, index) => (
            <button key={item.slug} type="button" role="tab" aria-selected={index === active} onClick={() => setActive(index)}>
              <b>{item.who}</b><span>{item.platform}</span>{item.truth ? <em>{J_SAMPLES.truthTag}</em> : null}
            </button>
          ))}
        </div>
        <article key={report.slug} role="tabpanel" aria-label={`${report.who} · ${report.platform}`} className={styles.sampleCard}>
          <header className={samples.cover}>
            <FileText size={22} aria-hidden="true" />
            <div>
              <p className={samples.coverLabel}>{J_SAMPLES.coverLabel}{report.truth ? <em>{J_SAMPLES.truthTag}</em> : null}</p>
              <h3 className={styles.coverTitle}>{report.who} · {report.platform}</h3>
              <p className={samples.size}>{J_SAMPLES.size} · {J_SAMPLES.generated(data.generatedAt)}</p>
            </div>
          </header>
          <Glance data={data} />
          <FullReport slug={report.slug} />
        </article>
        <CtaK />
      </div>
    </section>
  );
}
