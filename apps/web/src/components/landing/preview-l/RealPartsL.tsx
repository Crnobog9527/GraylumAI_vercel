/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { REPORT_TITLE, REPORT_WRITING_NOTICE } from '@/app/app/positioning/[draftId]/report-gen';
import { DisplayHeading } from '@/components/chat-display/display-heading';
import { CHAT_ACTION, ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import type { ClipParts } from '@/components/landing/preview-j/PositioningClipJ';
import result from '@/components/opc/positioning-result.module.css';
import { BenchmarkTable } from '@/components/research/benchmark-table';
import type { BenchmarkRow } from '@/components/research/benchmark-table-model';
import { ResearchCallList } from '@/components/research/research-call-list';
import { DATA_SOURCE_NOTE, type ResearchCall } from '@/components/research/research-model';
import { Button } from '@/components/ui/button';
import { OFFICE_WORKER_REPORT } from '@/lib/landing/sample-reports/office-worker';
import { SAMPLE_OVERVIEWS } from '@/lib/landing/sample-reports/overview';
import { EarningsL } from './EarningsL';
import { FullReportL } from './FullReportL';
import { OverviewL } from './OverviewL';
import picture from './picture-l.module.css';

/**
 * Sample L, round four (Owner 2026-10-17: "落地页所有产品界面的这个组件，你不要自己再重新写一遍"): the real product's
 * components in place of sample J's drawn ones inside the positioning picture. The research step shows the real search
 * record (ResearchCallList) and the real benchmark table (BenchmarkTable) with this person's report's own figures (its
 * chapter 5: 对标账号 A–E, F and G as references); the drawn first-month plan card goes. The report is the product's
 * report dialog as report-panel.tsx lays it out — its card, title, close button, Markdown and the "正在写报告…" notice
 * with 停止 — made of the same components and constants (report-panel.tsx itself still reads its own data; turning it
 * into a display component is scheduled on the product side).
 */
const NOW = new Date('2026-10-15T08:00:00Z');
const metric = (value: number | null, ref: string) => ({ value, refs: value === null ? [] : [ref] });
/**
 * One account's row; its figures all come from that account's own source record (ev1 for A … ev7 for G), so the list
 * under the table reads "[n] 账号名 的数据来源记录（编号 evX）" once per account, as in the product (#1150).
 */
const row = (n: number, followers: number, median: number, rate: number, perWeek: number, qualified = true): BenchmarkRow => {
  const ref = `ev${n}#1`;
  return {
    platform: 'tiktok', account: `对标账号 ${'ABCDEFG'[n - 1]}`, category: qualified ? 'imitable' : 'head_reference', qualified,
    metrics: {
      followers: metric(followers, ref), medianViews: metric(median, ref), engagementRate: metric(rate, ref),
      postsPerWeek: metric(perWeek, ref), lastPublishedAt: { value: '2026-10-14T02:00:00Z', refs: [ref] },
    },
  };
};
/**
 * The report's chapter 5 (office-worker.json): accounts by label only, figures as published there. Round twelve (D4,
 * Owner 2026-10-18: "表格信息数据，全部都要填满"): every cell filled, F's and G's views and rate and everyone's posts a
 * week added (示例数据), only what public data gives.
 */
export const L_BENCHMARK_ROWS: BenchmarkRow[] = [
  row(1, 98_000, 12_000, 0.12, 3), row(2, 112_000, 7_000, 0.11, 2), row(3, 17_000, 37_000, 0.11, 4),
  row(4, 93_000, 22_000, 0.06, 1), row(5, 36_000, 13_000, 0.08, 2),
  row(6, 97_000, 24_000, 0.07, 5, false), row(7, 28_000, 11_000, 0.09, 3, false),
];
/** Under the table: the Owner's sentence on where the data comes from, then that it is an example. */
const BENCHMARK_NOTE = `${DATA_SOURCE_NOTE}（示例数据）`;

/** What the coach looked up for this person, in the product's own call shapes; each finishes as the step plays. */
const CALLS: readonly Omit<ResearchCall, 'state'>[] = [
  { callId: 'l1', toolName: 'benchmark_discover', args: {}, query: '15 minute dinner、one pot meal', platform: 'tiktok', dataKind: 'keyword_posts' },
  { callId: 'l2', toolName: 'benchmark_discover', args: {}, query: '一人食、下班做饭', platform: 'tiktok', dataKind: 'keyword_posts' },
  { callId: 'l3', toolName: 'benchmark_fetch', args: {}, query: '对标账号 A–E', platform: 'tiktok', dataKind: 'account_posts' },
];
const callsAt = (local: number): ResearchCall[] =>
  CALLS.map((call, index) => ({ ...call, state: local * CALLS.length > index + 0.5 ? 'succeeded' : 'running' } as ResearchCall));

/** The whole report: its chapters in order, as Markdown (the version the overview is drawn from). */
const REPORT_TEXT = OFFICE_WORKER_REPORT.revised.map(chapter => `## ${chapter.title}\n\n${chapter.markdown}`).join('\n\n');
const OVERVIEW = SAMPLE_OVERVIEWS['office-worker'];

/**
 * The report at the end of step one, round six (Owner 2026-10-17: "这个 1 万多字的报告是没人看的，把这里这个报告替换为我们现在新版
 * 的可视化的这个报告……这个报告的显示框现在是被裁切掉的"): the product's report dialog card (report-panel.tsx's layout, its
 * title, close button and "正在写报告…" with 停止) holding the visual overview the sample reports use (OverviewL), drawn
 * from this person's own report and written block by block. The card fits the
 * picture: its frame here gives it the picture's height and it scrolls inside, following the writing.
 *
 * Round nine (V1): once written, the overview ends with "查看完整报告", which opens the whole report in a dialog of its
 * own (FullReportL: the product's ReportView with its chapter list, as in round seven's T4), not under the overview. This
 * report carries no strategy data block, so ReportView shows its text without per-chapter charts.
 */
function ReportDialogL({ writing, local }: { writing: boolean; local: number }) {
  const reveal = writing ? Math.min(1, Math.max(0.1, local * 1.15)) : 1;
  const live = writing && reveal < 1;
  const card = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (live && card.current) card.current.scrollTop = card.current.scrollHeight;
  }, [live, reveal]);
  const notices = live ? [{ id: 'report-live', tone: 'status' as const, busy: true, text: REPORT_WRITING_NOTICE,
    actions: [{ label: CHAT_ACTION.stop, onClick: () => undefined }] }] : [];
  return (
    <div role="dialog" aria-modal="false" aria-label={REPORT_TITLE}
      className="absolute inset-0 z-50 flex justify-center bg-black/40 p-4">
      <div className={picture.reportFit}>
        {/* The card as report-panel.tsx's ReportDialog writes it, `!max-w-3xl` included. */}
        <div ref={card} className={`${result.consentCard} !max-w-3xl`}>
          <header>
            <DisplayHeading as="h2">{REPORT_TITLE}</DisplayHeading>
            <Button className={result.consentClose} variant="ghost" aria-label={`关闭${REPORT_TITLE}`} tabIndex={-1}>
              <X size={18} aria-hidden="true" />
            </Button>
          </header>
          <div className="mt-4"><OverviewL data={OVERVIEW} reveal={reveal} money={<EarningsL />} /></div>
          <ChatNoticeList className="mt-4" notices={notices} />
          {/* Round nine (V1): the whole report opens in a dialog of its own, not under the overview. */}
          {live ? null : <div className={picture.fullReport}><FullReportL title={REPORT_TITLE} text={REPORT_TEXT} /></div>}
        </div>
      </div>
    </div>
  );
}

export const L_CLIP_PARTS: ClipParts = {
  card: (card, fetchLocal) => {
    if (card === 'fetch') return <ResearchCallList calls={callsAt(fetchLocal)} />;
    if (card === 'table') return <BenchmarkTable rows={L_BENCHMARK_ROWS} now={NOW} note={BENCHMARK_NOTE} />;
    if (card === 'plan') return null;
    return undefined;
  },
  report: (writing, local) => <ReportDialogL writing={writing} local={local} />,
};
