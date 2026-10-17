/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { FileText, X } from 'lucide-react';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { FullReport } from '@/components/landing/preview-j/SamplesJ';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { L_REPORTS } from '@/lib/landing/landing-copy-l';
import { L_SAMPLES_REDO as COPY } from '@/lib/landing/landing-copy-l-samples';
import { SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { SAMPLE_OVERVIEWS } from '@/lib/landing/sample-reports/overview';
import { OverviewL } from './OverviewL';
import styles from './l.module.css';
import own from './samples-l.module.css';

type Report = (typeof L_REPORTS)[number];
/** Each half of the moving row holds at least this many cards, so the row is never shorter than a wide screen. */
const MIN_CARDS = 8;

/**
 * Region 4 (Owner 2026-10-17, redone): "找到和你情况一样的人". Every group's sample report is a card of one size in a row
 * that keeps moving from right to left; the pointer or keyboard focus on it holds it. A card shows the group and
 * platform, the one-sentence conclusion (three lines at most), its tags (「示例」, and 「方向已调整」 when the coach changed
 * the direction) and 「看这份报告」. Every visible card opens its report, the loop's second copy too: that copy is hidden
 * from screen readers and taken out of the tab order, but a click on it works. The dialog: the cover, the 15-second
 * overview (OverviewL, round five) and the whole report behind "看完整报告". Reduced motion and touch screens: the row stands still and is
 * swiped by hand. New reports join by adding them to L_REPORTS and sample-reports/.
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
          <h2 id="samples-title" className={k.lead}>{COPY.title}</h2>
          <p className={own.lede}>
            {COPY.ledeParts(reports.length).map(part => <span key={part} className={own.keep}>{part}</span>)}
          </p>
        </div>
      </div>
      <div className={styles.marquee} data-region="报告卡片">
        <div className={styles.marqueeTrack} style={{ '--count': half.length } as CSSProperties}>
          {[0, 1].map(copy => (
            <ul key={copy} className={styles.marqueeList} aria-hidden={copy === 1 || undefined} data-copy={copy}>
              {half.map((report, index) => (
                <li key={`${report.slug}-${index}`}>
                  <button type="button" className={own.card} onClick={() => show(report)} tabIndex={copy === 1 ? -1 : undefined}
                    data-slug={report.slug} aria-label={`${COPY.open}：${report.who} · ${report.platform}`}>
                    <span className={own.cardHead}>
                      <FileText size={15} aria-hidden="true" /><span><b>{report.who}</b>{report.platform}</span>
                    </span>
                    <span className={own.cardWhat}>{SAMPLE_CHAPTERS[report.slug].summary.what}</span>
                    <span className={own.tags}>
                      <span className={own.sampleTag}>{COPY.sample}</span>
                      {report.truth ? <span className={own.adjustedTag}>{COPY.adjusted}</span> : null}
                    </span>
                    <span className={own.cardOpen}>{COPY.open}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
      <div className={k.wrap}><CtaK /></div>

      <dialog ref={dialog} className={styles.reportDialog} aria-label={open ? `${open.who} · ${open.platform}` : COPY.title}
        onClose={() => setOpen(null)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        {open && data ? (
          <div className={styles.dialogBody}>
            <button type="button" className={styles.dialogClose} onClick={() => dialog.current?.close()} aria-label={COPY.close}>
              <X size={18} aria-hidden="true" />
            </button>
            <header className={samples.cover}>
              <FileText size={22} aria-hidden="true" />
              <div className={own.coverText}>
                <p className={samples.coverLabel}>{J_SAMPLES.coverLabel}<span className={own.sampleTag}>{COPY.sample}</span></p>
                <h3 className={k.coverTitle}>{open.who} · {open.platform}</h3>
                <p className={samples.size}>{J_SAMPLES.size}</p>
              </div>
            </header>
            {SAMPLE_OVERVIEWS[open.slug] ? <OverviewL data={SAMPLE_OVERVIEWS[open.slug]} /> : null}
            <FullReport key={open.slug} slug={open.slug} />
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
