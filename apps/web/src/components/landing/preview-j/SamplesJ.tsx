/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, FileText } from 'lucide-react';
import { J_SAMPLES, samplePath } from '@/lib/landing/landing-copy-j-samples';
import styles from './samples-j.module.css';

/**
 * The four sample reports opening "AI 教练怎么接手你的运营" (Owner 2026-10-15): each card is a report in its layout —
 * the group and platform, three excerpts (一句话定位和为什么 / 第一个 30 天计划 / 变现路线) and the way to the full report.
 * The reports are not generated yet, so every excerpt is a clearly marked "样例报告生成中" placeholder; the caller
 * shows this block only in a local preview or behind the `sampleReports` flag.
 */
export function SamplesJ() {
  return (
    <div className={styles.samples}>
      <div className={styles.head}>
        <h3>{J_SAMPLES.title}</h3>
        <p>{J_SAMPLES.lede}</p>
      </div>
      <ul className={styles.cards}>
        {J_SAMPLES.reports.map(report => (
          <li key={report.slug}>
            <article className={styles.card} aria-label={`${report.who} · ${report.platform}`}>
              <header>
                <FileText size={16} aria-hidden="true" />
                <b>{report.who}</b><span>{report.platform}</span>
                {report.truth ? <em>{J_SAMPLES.truthTag}</em> : null}
              </header>
              <p className={styles.pending} role="status">{J_SAMPLES.pending}</p>
              {J_SAMPLES.sections.map(section => (
                <section key={section.key} aria-label={section.title}>
                  <h4>{section.title}</h4>
                  <span className={styles.line} aria-hidden="true" />
                  <span className={styles.line} aria-hidden="true" data-short="" />
                </section>
              ))}
              <Link href={samplePath(report.slug)} className={styles.more}>
                {J_SAMPLES.more}<ArrowRight size={15} aria-hidden="true" />
              </Link>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}
