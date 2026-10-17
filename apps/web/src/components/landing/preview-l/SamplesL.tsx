/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import k from '@/components/landing/preview-k/k.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { L_REPORTS } from '@/lib/landing/landing-copy-l';
import { L_SAMPLES_REDO as COPY } from '@/lib/landing/landing-copy-l-samples';
import { SAMPLE_OVERVIEWS } from '@/lib/landing/sample-reports/overview';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import demo from './demo-l.module.css';
import { FullReportL } from './FullReportL';
import { OverviewL } from './OverviewL';
import own from './samples-l.module.css';

type Report = (typeof L_REPORTS)[number];
const bySlug = new Map(L_REPORTS.map(report => [report.slug, report]));

/**
 * Region 5 (Owner 2026-10-17; round eight, U6, 2026-10-18: "用户案例和用户成果对用户来说特别重要，也是增加信任度的地方……
 * 怎么样去加强这种重视感"): "找到和你情况一样的人". Under the title a strip of figures; then two columns: on the left the
 * 14 people in four groups (on a phone, one row of chips that scrolls sideways), on the right the chosen person's
 * report overview itself (OverviewL, the dialog's), read in place without opening anything: the coach's change of
 * direction first when there was one, then the overview, then "查看完整报告" (round nine, V1: the whole report alone in
 * a dialog of its own, FullReportL) and the way to get one's own. Every person is an example and says so (「示例」,
 * 「方向已调整」).
 */
export function SamplesL() {
  const [slug, setSlug] = useState<string>(COPY.defaultSlug);
  const viewer = useRef<HTMLDivElement>(null);
  const chosen = bySlug.get(slug) ?? L_REPORTS[0];
  const overview = SAMPLE_OVERVIEWS[chosen.slug];
  const pick = (next: string) => { setSlug(next); if (viewer.current) viewer.current.scrollTop = 0; };
  return (
    <section aria-labelledby="samples-title" className={k.section} data-zone="takeover" data-region="样例报告">
      <div className={k.wrap}>
        <div className={own.head}>
          <h2 id="samples-title" className={k.lead}>{COPY.title}</h2>
          <ul className={own.stats}>{COPY.stats(L_REPORTS.length).map(item => <li key={item}>{item}</li>)}</ul>
        </div>
        <div className={own.browser}>
          <nav aria-label={COPY.pickLabel} className={cn(own.picker, demo.scrollbar)}>
            {COPY.groups.map(group => (
              <div key={group.name} className={own.group}>
                <p className={own.groupName}>{group.name}</p>
                <ul>
                  {group.slugs.map(id => bySlug.get(id)).filter((report): report is Report => Boolean(report)).map(report => (
                    <li key={report.slug}>
                      <button type="button" data-slug={report.slug} aria-pressed={report.slug === chosen.slug} onClick={() => pick(report.slug)}>
                        <b>{report.who}</b><span>{report.platform}</span>
                        {report.truth ? <em className={own.adjustedTag}>{COPY.adjusted}</em> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div ref={viewer} className={cn(own.viewer, demo.scrollbar)} role="region" aria-live="polite"
            aria-label={COPY.viewing(chosen.who, chosen.platform)}>
            <header className={own.viewerHead}>
              <FileText size={18} aria-hidden="true" />
              <p><b>{chosen.who}</b><span>{chosen.platform}</span></p>
              <span className={own.tags}>
                <span className={own.sampleTag}>{COPY.sample}</span>
                {chosen.truth ? <span className={own.adjustedTag}>{COPY.adjusted}</span> : null}
              </span>
            </header>
            {chosen.truth && overview?.riskAlert ? (
              <p className={own.adjustedNote}><b>{COPY.adjustedLead}</b>{overview.riskAlert.headline}</p>
            ) : null}
            {overview ? <OverviewL key={chosen.slug} data={overview} /> : null}
            <div className={own.actions}>
              <FullReportL key={chosen.slug} title={`${chosen.who} · ${chosen.platform}`} slug={chosen.slug} />
              <Link href={SIGNUP_CTA_HREF} className={page.pill}>{COPY.mine}</Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
