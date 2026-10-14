/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowRight, FileText } from 'lucide-react';
import { J_SAMPLES, samplePath } from '@/lib/landing/landing-copy-j-samples';
import styles from './samples-j.module.css';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The four sample reports as a walkthrough (Owner 2026-10-15): pick a report; its cover comes first (who, platform,
 * how long), then every chapter of the real report lights up in turn with what it gives you and its key conclusion,
 * so the visitor sees the whole set of answers they would get. The reports are not generated yet: every conclusion
 * is a clearly marked placeholder. The caller shows this block only in a local preview or behind the flag. With
 * reduced motion, everything is simply there.
 */
export function SamplesJ() {
  const [active, setActive] = useState(0);
  const [play, setPlay] = useState(false);
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
  return (
    <div ref={ref} className={styles.samples}>
      <div className={styles.head}>
        <h3>{J_SAMPLES.title}</h3>
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
            <p className={styles.size}>{J_SAMPLES.size}</p>
          </div>
          <p className={styles.pending} role="status">{J_SAMPLES.pending}</p>
        </header>
        <ol className={styles.chapters}>
          {J_SAMPLES.chapters.map((chapter, index) => (
            <li key={chapter.title} style={{ '--i': index } as CSSProperties}>
              <b>{chapter.title}</b>
              <p><span>{J_SAMPLES.giveLabel}</span>{chapter.give}</p>
              <p className={styles.key}><span>{J_SAMPLES.keyLabel}</span><i aria-hidden="true" /><small>{J_SAMPLES.pending}</small></p>
            </li>
          ))}
        </ol>
        <Link href={samplePath(report.slug)} className={styles.more}>{J_SAMPLES.more}<ArrowRight size={15} aria-hidden="true" /></Link>
      </article>
    </div>
  );
}
