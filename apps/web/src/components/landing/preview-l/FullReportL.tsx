/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { ReportWithOutline } from '@/components/chat-display/report-outline';
import { ReportView } from '@/components/chat-display/report-view/report-view';
import { useReportOutline } from '@/components/chat-display/use-report-outline';
import { L_SAMPLES_REDO as COPY } from '@/lib/landing/landing-copy-l-samples';
import { loadSampleReport } from '@/lib/landing/sample-reports';
import demo from './demo-l.module.css';
import styles from './full-report-l.module.css';

/**
 * "查看完整报告" and the whole report in a dialog of its own (round nine, V1, Owner 2026-10-18: "纯文字版的报告不要和
 * 上面的可视化内容粘在一起……做成这种嵌套的弹窗式浏览"), shared by step one's report and region 5: under an overview,
 * only this button; it opens a second, modal dialog holding nothing but the report, the product's way (ReportWithOutline
 * with ReportView: the chapter list beside the text). Being the browser's own modal dialog, Esc closes only it, the
 * page and the overview under it stay where they were, and focus goes back to the button. `text` is the report, or
 * `slug` a sample report to load when it is first opened.
 */
export function FullReportL({ title, text, slug }: { title: string; text?: string; slug?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [body, setBody] = useState<string | null>(text ?? null);
  const [shown, setShown] = useState(false);
  const outline = useReportOutline(dialog);
  const open = () => {
    setShown(true);
    dialog.current?.showModal();
    if (body === null && slug) void loadSampleReport(slug).then(setBody);
  };
  return (
    <>
      <button type="button" className={styles.open} onClick={open}>
        <FileText size={16} aria-hidden="true" />{COPY.fullReportOpen}
      </button>
      <dialog ref={dialog} className={`${styles.dialog} ${demo.scrollbar}`} aria-label={`${title} · ${COPY.reportBody}`}
        onClose={() => setShown(false)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <header className={styles.head}>
          <p>{title}<span>{COPY.reportBody}</span></p>
          <button type="button" className={styles.close} onClick={() => dialog.current?.close()} aria-label={COPY.close}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {/* The outline watches its text from the start; the text arrives when the dialog is first opened. */}
        <ReportWithOutline bodyRef={outline.bodyRef} chapters={outline.chapters} activeId={outline.activeId} onSelect={outline.select}>
          {shown || body !== null ? (body === null ? <p className={styles.loading}>{COPY.loading}</p> : <ReportView body={body} />) : null}
        </ReportWithOutline>
      </dialog>
    </>
  );
}
