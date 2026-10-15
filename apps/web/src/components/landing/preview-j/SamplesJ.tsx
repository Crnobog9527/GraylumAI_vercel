/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { MentorMarkdown } from '@/app/positioning/[draftId]/MentorMarkdown';
import result from '@/components/opc/positioning-result.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { loadSampleReport, SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import styles from './samples-j.module.css';
import page from './j.module.css';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The four sample reports as a walkthrough (Owner 2026-10-15): pick a report; its cover comes first (who, platform,
 * when it was generated), then every chapter of the real report lights up in turn with what it gives this person and
 * its key conclusion. "看完整报告" opens the whole report in place, read-only and scrollable (loaded on demand). The
 * caller shows this block only in a local preview or behind the flag. With reduced motion, everything is simply there.
 */
export function SamplesJ() {
  const [active, setActive] = useState(0);
  const [play, setPlay] = useState(false);
  // A phone shows the first chapters and a button for the rest; folding only after mount keeps the server HTML whole.
  const [folded, setFolded] = useState(false);
  useEffect(() => { if (window.matchMedia?.('(max-width: 639px)').matches) setFolded(true); }, []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setPlay(true); observer.disconnect(); }
    }, { threshold: 0.25 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const report = J_SAMPLES.reports[active];
  const data = SAMPLE_CHAPTERS[report.slug];
  return (
    <div ref={ref} className={styles.samples}>
      <div className={styles.head}>
        <h2 className={page.display}>{J_SAMPLES.title}</h2>
        <p>{J_SAMPLES.lede}</p>
      </div>
      <div role="tablist" aria-label="样例报告" className={styles.tabs}>
        {J_SAMPLES.reports.map((item, index) => (
          <button key={item.slug} type="button" role="tab" aria-selected={index === active} onClick={() => setActive(index)}>
            <b>{item.who}</b><span>{item.platform}</span>{item.truth ? <em>{J_SAMPLES.truthTag}</em> : null}
          </button>
        ))}
      </div>
      <article key={report.slug} role="tabpanel" aria-label={`${report.who} · ${report.platform}`} className={styles.report}
        data-play={play || undefined}>
        <header className={styles.cover}>
          <FileText size={22} aria-hidden="true" />
          <div>
            <p className={styles.coverLabel}>{J_SAMPLES.coverLabel}{report.truth ? <em>{J_SAMPLES.truthTag}</em> : null}</p>
            <h4>{report.who} · {report.platform}</h4>
            <p className={styles.size}>{J_SAMPLES.size} · {J_SAMPLES.generated(data.generatedAt)}</p>
          </div>
        </header>
        <ol id={`j-samples-${report.slug}`} className={styles.chapters} data-folded={folded || undefined}>
          {J_SAMPLES.chapters.map((title, index) => (
            <li key={title} style={{ '--i': index } as CSSProperties}>
              <b>{title}</b>
              <p><span>{J_SAMPLES.giveLabel}</span>{data.chapters[index]?.give}</p>
              <p className={styles.key}><span>{J_SAMPLES.keyLabel}</span>{data.chapters[index]?.key}</p>
            </li>
          ))}
        </ol>
        {folded ? (
          <button type="button" className={styles.unfold} aria-controls={`j-samples-${report.slug}`} aria-expanded="false" onClick={() => setFolded(false)}>
            {J_SAMPLES.unfold(J_SAMPLES.chapters.length)}<ChevronDown size={16} aria-hidden="true" />
          </button>
        ) : null}
        <FullReport slug={report.slug} />
      </article>
    </div>
  );
}

/** The whole report, opened in place: read-only, scrollable, loaded the first time it is opened. */
function FullReport({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open || text !== null) return;
    let live = true;
    void loadSampleReport(slug).then(markdown => { if (live) setText(markdown); });
    return () => { live = false; };
  }, [open, slug, text]);
  return (
    <>
      <button type="button" className={styles.more} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        {open ? J_SAMPLES.less : J_SAMPLES.more}{open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
      </button>
      <div id={panelId} className={styles.full} hidden={!open} tabIndex={-1}>
        {text === null ? <p className={styles.loading}>{J_SAMPLES.loading}</p>
          : <MentorMarkdown className={result.messageBody} text={text} live={false} />}
      </div>
    </>
  );
}
