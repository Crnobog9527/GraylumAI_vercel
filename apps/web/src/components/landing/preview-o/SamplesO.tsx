/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { FileText, X } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { FullReport, Glance } from '@/components/landing/preview-j/SamplesJ';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import l from '@/components/landing/preview-l/l.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { L_REPORTS, L_SAMPLES } from '@/lib/landing/landing-copy-l';
import { SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { O_STATIONS } from './copy-o';
import { StationO } from './RouteO';
import styles from './o.module.css';

type Report = (typeof L_REPORTS)[number];
/** Each half of the moving row holds at least this many cards, so the row is never shorter than a wide screen. */
const MIN_CARDS = 8;

/**
 * Region 4, station "别人走到了这": sample L's moving row of every group's sample report, kept inside the content column
 * (the rail stays clear), each card white with the gold station mark on its left. A card opens sample L's dialog: the
 * cover, the 10-second card and the whole report (Glance and FullReport, unchanged). The row's motion, its pause on
 * hover or focus, and its still, hand-scrolled form under reduced motion are sample L's (l.module.css).
 */
export function SamplesO({ station }: { station: string }) {
  const [open, setOpen] = useState<Report | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reports = L_REPORTS;
  const half = Array.from({ length: Math.ceil(MIN_CARDS / reports.length) }, () => reports).flat();
  const show = (report: Report) => { setOpen(report); dialog.current?.showModal(); };
  const data = open ? SAMPLE_CHAPTERS[open.slug] : null;
  return (
    <section aria-labelledby="samples-title" className={styles.section} data-region="样例报告">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <StationO n={station} label={O_STATIONS.samples} />
          <h2 id="samples-title" className={styles.title}>{L_SAMPLES.title(reports.length)}</h2>
          <p className={styles.lede}>{L_SAMPLES.bridge}<span className={styles.hint}>{L_SAMPLES.pause}</span></p>
        </div>
        <div className={l.marquee} data-region="报告卡片">
          <div className={l.marqueeTrack} style={{ '--count': half.length } as CSSProperties}>
            {[0, 1].map(copy => (
              <ul key={copy} className={l.marqueeList} aria-hidden={copy === 1 || undefined} inert={copy === 1 || undefined}>
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
