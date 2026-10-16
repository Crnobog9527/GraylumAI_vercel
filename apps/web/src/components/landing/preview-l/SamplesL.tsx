/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { FileText, X } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { FullReport, Glance } from '@/components/landing/preview-j/SamplesJ';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { L_REPORTS, L_SAMPLES } from '@/lib/landing/landing-copy-l';
import { SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import styles from './l.module.css';

type Report = (typeof L_REPORTS)[number];
/** Each half of the moving row holds at least this many cards, so the row is never shorter than a wide screen. */
const MIN_CARDS = 8;

/**
 * Region 4 (Owner 2026-10-17): every group's sample report as a card in one row that keeps moving from right to left;
 * the pointer or keyboard focus on it holds it. A card opens its report in a dialog: the cover, the 10-second card and
 * the whole report behind "看完整报告". The row is the list twice over, the second copy hidden from screen readers and
 * the keyboard, so the loop is seamless. Reduced motion: the row stands still and scrolls sideways by hand. New
 * reports join by adding them to L_REPORTS and sample-reports/.
 */
export function SamplesL() {
  const [open, setOpen] = useState<Report | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reports = L_REPORTS;
  const half = Array.from({ length: Math.ceil(MIN_CARDS / reports.length) }, () => reports).flat();
  const show = (report: Report) => { setOpen(report); dialog.current?.showModal(); };
  const data = open ? SAMPLE_CHAPTERS[open.slug] : null;
  return (
    <section aria-labelledby="samples-title" className={k.section} data-zone="takeover" data-region="样例报告">
      <div className={k.wrap}>
        <div className={k.samplesHead}>
          <p className={k.bridge}>{L_SAMPLES.bridge}</p>
          <h2 id="samples-title" className={k.lead}>{L_SAMPLES.title(reports.length)}</h2>
          <p className={styles.marqueeHint}>{L_SAMPLES.pause}</p>
        </div>
      </div>
      <div className={styles.marquee} data-region="报告卡片">
        <div className={styles.marqueeTrack} style={{ '--count': half.length } as CSSProperties}>
          {[0, 1].map(copy => (
            <ul key={copy} className={styles.marqueeList} aria-hidden={copy === 1 || undefined} inert={copy === 1 || undefined}>
              {half.map((report, index) => (
                <li key={`${report.slug}-${index}`}>
                  <button type="button" className={styles.reportCard} onClick={() => show(report)}
                    aria-label={`${L_SAMPLES.open}：${report.who} · ${report.platform}`}>
                    <span className={styles.cardHead}><FileText size={16} aria-hidden="true" /><b>{report.who}</b>{report.platform}</span>
                    {report.truth ? <em>{J_SAMPLES.truthTag}</em> : null}
                    <span className={styles.cardWho}>{SAMPLE_CHAPTERS[report.slug].summary.who}</span>
                    <span className={styles.cardWhat}>{SAMPLE_CHAPTERS[report.slug].summary.what}</span>
                    <span className={styles.cardOpen}>{L_SAMPLES.open}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
      <div className={k.wrap}><CtaK /></div>

      <dialog ref={dialog} className={styles.reportDialog} aria-label={open ? `${open.who} · ${open.platform}` : L_SAMPLES.title(reports.length)}
        onClose={() => setOpen(null)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        {open && data ? (
          <div className={styles.dialogBody}>
            <button type="button" className={styles.dialogClose} onClick={() => dialog.current?.close()} aria-label={L_SAMPLES.close}>
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
