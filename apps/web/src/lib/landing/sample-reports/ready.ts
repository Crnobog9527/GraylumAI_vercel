/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SAMPLE_CHAPTERS, SAMPLE_REPORT_SLUGS } from './index';
import { SAMPLE_OVERVIEWS } from './overview';

/**
 * Whether the landing page's sample reports are ready to show (the `sampleReports` fact switch, Owner 2026-10-17: one
 * of the three facts the page may not claim before they are true): every one of the 14 people has its report
 * generated (a date), its chapter cards, its whole text to load and its 15-second overview. That the texts follow the
 * Owner's privacy rule (no @handles, no links) is checked against the texts themselves in the tests.
 */
export function sampleReportsReady(): boolean {
  const slugs = Object.keys(SAMPLE_CHAPTERS);
  return slugs.length === 14
    && slugs.every(slug => SAMPLE_REPORT_SLUGS.includes(slug))
    && slugs.every(slug => Boolean(SAMPLE_CHAPTERS[slug].generatedAt) && SAMPLE_CHAPTERS[slug].chapters.length > 0)
    && slugs.every(slug => Boolean(SAMPLE_OVERVIEWS[slug]));
}
