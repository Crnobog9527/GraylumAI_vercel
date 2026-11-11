/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { REPORT_TITLE, REPORT_WRITING_NOTICE } from '@/app/(zh-hans)/app/positioning/[draftId]/report-gen';
import { DisplayHeading } from '@/components/chat-display/display-heading';
import { CHAT_ACTION, ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { BenchmarkTable } from '@/components/research/benchmark-table';
import type { BenchmarkRow } from '@/components/research/benchmark-table-model';
import { ResearchCallList } from '@/components/research/research-call-list';
import { DATA_SOURCE_NOTE, type ResearchCall } from '@/components/research/research-model';
import { SAMPLE_OVERVIEWS } from '@/lib/landing/sample-reports/overview';
import { EarningsL } from './EarningsL';
import { OverviewL } from './OverviewL';
import flow from './flow-l.module.css';

/**
 * Sample L's step one, on the real product's components (Owner 2026-10-17: "落地页所有产品界面的这个组件，你不要自己再重新写
 * 一遍"), as the modules of 2026-11-11 show them: the research step is the real search record (ResearchCallList) and the
 * real benchmark table (BenchmarkTable) with this person's report's own figures (its chapter 5: 对标账号 A–E, F and G
 * as references); the report is the visual overview the sample reports use (OverviewL), under the product's report
 * title and its "正在写报告…" notice with 停止.
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

/** The search record, `local` (0 → 1) through the fetch: each call running, then done. */
export function ResearchCallsL({ local }: { local: number }) {
  const calls = CALLS.map((call, index) => ({ ...call, state: local * CALLS.length > index + 0.5 ? 'succeeded' : 'running' } as ResearchCall));
  return <ResearchCallList calls={calls} />;
}

/** The benchmark table with this person's report's figures. */
export function BenchmarkL() {
  return <BenchmarkTable rows={L_BENCHMARK_ROWS} now={NOW} note={BENCHMARK_NOTE} />;
}

const OVERVIEW = SAMPLE_OVERVIEWS['office-worker'];

/**
 * The report at the end of step one (Owner 2026-10-17, round six: "这个 1 万多字的报告是没人看的，把这里这个报告替换为我们现在
 * 新版的可视化的这个报告"): the visual overview drawn from this person's own report, written block by block (`reveal`,
 * 0 → 1), under the product's report title; while it is being written, the product's "正在写报告…" notice with 停止.
 */
export function ReportOverviewL({ reveal }: { reveal: number }) {
  const live = reveal < 1;
  const notices = live ? [{ id: 'report-live', tone: 'status' as const, busy: true, text: REPORT_WRITING_NOTICE,
    actions: [{ label: CHAT_ACTION.stop, onClick: () => undefined }] }] : [];
  return (
    <>
      <DisplayHeading as="h2" className={flow.reportHead}>{REPORT_TITLE}</DisplayHeading>
      <OverviewL data={OVERVIEW} reveal={Math.max(0.1, reveal)} money={<EarningsL />} />
      <ChatNoticeList notices={notices} />
    </>
  );
}
