/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { FileText, X } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import l from '@/components/landing/preview-l/l.module.css';
import { FullReport, Glance } from '@/components/landing/preview-j/SamplesJ';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { L_REPORTS, L_SAMPLES } from '@/lib/landing/landing-copy-l';
import { SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { cn } from '@/lib/utils';
import styles from './n.module.css';

type Report = (typeof L_REPORTS)[number];
/** Each half of the moving row holds at least this many cards, so the row is never shorter than a wide screen. */
const MIN_CARDS = 8;

/**
 * Region 4 (sample L's moving row of report cards, set as cells): every group's sample report as a white cell in one
 * row that keeps moving; the pointer or keyboard focus holds it, and a cell opens its report in sample L's dialog
 * (the cover, the 10-second card and the whole report, SamplesJ's own parts). The row sits inside the page's width
 * so the frame can rest on it. Reduced motion: the row stands still and scrolls sideways by hand.
 */
export function SamplesN() {
  const [open, setOpen] = useState<Report | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reports = L_REPORTS;
  const half = Array.from({ length: Math.ceil(MIN_CARDS / reports.length) }, () => reports).flat();
  const show = (report: Report) => { setOpen(report); dialog.current?.showModal(); };
  const data = open ? SAMPLE_CHAPTERS[open.slug] : null;
  return (
    <section id="samples" aria-labelledby="samples-title" className={styles.section} data-zone="samples" data-region="样例报告">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <p className={styles.bridge}>{L_SAMPLES.bridge}</p>
          <h2 id="samples-title" className={styles.h2}>{L_SAMPLES.title(reports.length)}</h2>
          <p className={styles.hint}>{L_SAMPLES.pause}</p>
        </div>
        <div className={cn(l.marquee, styles.marquee)} data-region="报告卡片" data-key="">
          <div className={l.marqueeTrack} style={{ '--count': half.length } as CSSProperties}>
            {[0, 1].map(copy => (
              <ul key={copy} className={cn(l.marqueeList, styles.marqueeList)} aria-hidden={copy === 1 || undefined} inert={copy === 1 || undefined}>
                {half.map((report, index) => (
                  <li key={`${report.slug}-${index}`}>
                    <button type="button" className={cn(l.reportCard, styles.report)} onClick={() => show(report)}
                      aria-label={`${L_SAMPLES.open}：${report.who} · ${report.platform}`}>
                      <span className={l.cardHead}><FileText size={16} aria-hidden="true" /><b>{report.who}</b>{report.platform}</span>
                      {report.truth ? <em>{J_SAMPLES.truthTag}</em> : null}
                      <span className={l.cardWho}>{SAMPLE_CHAPTERS[report.slug].summary.who}</span>
                      <span className={l.cardWhat}>{SAMPLE_CHAPTERS[report.slug].summary.what}</span>
                      <span className={l.cardOpen}>{L_SAMPLES.open}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
        <CtaK />
      </div>

      <dialog ref={dialog} className={l.reportDialog} aria-label={open ? `${open.who} · ${open.platform}` : L_SAMPLES.title(reports.length)}
        onClose={() => setOpen(null)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        {open && data ? (
          <div className={l.dialogBody}>
            <button type="button" className={l.dialogClose} onClick={() => dialog.current?.close()} aria-label={L_SAMPLES.close}>
              <X size={18} aria-hidden="true" />
            </button>
            <header className={samples.cover}>
              <FileText size={22} aria-hidden="true" />
              <div>
                <p className={samples.coverLabel}>{J_SAMPLES.coverLabel}{open.truth ? <em>{J_SAMPLES.truthTag}</em> : null}</p>
                <h3 className={k.coverTitle}>{open.who} · {open.platform}</h3>
                <p className={samples.size}>{J_SAMPLES.size} · {J_SAMPLES.generated(data.generatedAt)}</p>
              </div>
            </header>
            <Glance data={data} />
            <FullReport key={open.slug} slug={open.slug} />
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
