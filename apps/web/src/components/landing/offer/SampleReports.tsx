/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type KeyboardEvent } from 'react';
import { FileText } from 'lucide-react';
import { SAMPLE_LABEL, SAMPLE_REPORTS_TITLE, SAMPLE_SECTIONS, type SampleReport } from '@/lib/landing/landing-samples';
import { cn } from '@/lib/utils';

/**
 * Module 3b: audience tabs, one sample report per tab with three fixed parts. A report that has not been
 * generated yet shows only grey placeholder lines (staging and preview only: production shows this block
 * only once every report exists, see landing-samples.ts).
 */
export function SampleReports({ reports }: { reports: readonly SampleReport[] }) {
  const [active, setActive] = useState(0);
  if (reports.length === 0) return null;
  const report = reports[Math.min(active, reports.length - 1)];

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (active + step + reports.length) % reports.length;
    setActive(next);
    document.getElementById(`${reports[next].id}-tab`)?.focus();
  }

  return (
    <div className="mt-20">
      <h3 className="text-center text-2xl font-bold text-white">{SAMPLE_REPORTS_TITLE}</h3>
      <div role="tablist" aria-label={SAMPLE_REPORTS_TITLE} className="mt-6 flex gap-2 overflow-x-auto pb-2 md:flex-wrap md:justify-center">
        {reports.map((item, index) => (
          <button key={item.id} id={`${item.id}-tab`} type="button" role="tab" aria-selected={index === active}
            aria-controls={`${item.id}-panel`} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)} onKeyDown={onKey}
            className={cn('max-w-[16rem] flex-shrink-0 rounded-xl border px-4 py-2 text-left text-sm leading-snug transition-colors',
              index === active ? 'border-[#FFD700] bg-[#FFD700]/10 text-white' : 'border-[#2A2A2A] text-[#B0B0B0] hover:border-[#FFD700]/50')}>
            {item.audience}
          </button>
        ))}
      </div>
      <div id={`${report.id}-panel`} role="tabpanel" aria-labelledby={`${report.id}-tab`}
        className="mt-4 rounded-2xl border border-[#2A2A2A] bg-[#121212] p-5 md:p-8">
        <p className="flex items-center gap-2 text-sm text-[#B0B0B0]">
          <FileText className="h-4 w-4 text-[#FFD700]" aria-hidden="true" />
          《运营策略报告》
          <span className="rounded-full bg-[#FFD700]/15 px-2 py-0.5 text-xs font-semibold text-[#FFD700]">{SAMPLE_LABEL}</span>
        </p>
        <div className="mt-5 grid gap-6">
          {SAMPLE_SECTIONS.map(section => {
            const paragraphs = report.sections[section.key].filter(paragraph => paragraph.trim());
            return (
              <section key={section.key} aria-label={section.title} className="grid gap-2 border-l-2 border-[#FFD700]/50 pl-4">
                <p className="text-base font-semibold text-white">{section.title}</p>
                {paragraphs.length > 0
                  ? paragraphs.map(paragraph => <p key={paragraph} className="text-sm leading-relaxed text-[#D0D0D0]">{paragraph}</p>)
                  : (
                    <div aria-hidden="true" className="grid gap-2">
                      {['85%', '70%', '55%'].map(width => <span key={width} className="h-2 rounded-full bg-[#2E2E2E]" style={{ width }} />)}
                    </div>
                  )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
