/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SAMPLE_REPORT_DATA, sampleReportDataBlock } from '../../shared/reportDataSample';
import { reportStrategy, storedReportData } from './strategy';

const actor = randomUUID();
const execution = randomUUID();
const session = randomUUID();
const text = '## 一句话结论\n\n先做小红书。\n\n## 变现路径\n\n三层。';
const body = `${text}\n\n${sampleReportDataBlock()}`;
const row = (account: string) => ({ platform: 'xiaohongshu', account, followers: 18000, medianViews: 4200, engagementRate: 0.05,
  postsPerWeek: 3, lastPublishedAt: null, postsAnalyzed: 20, category: 'imitable', qualified: true, excluded: null, missing: [],
  fetchedAt: '2026-10-10T00:00:00Z' });

function admin({ source = {}, table = { rows: [row('示例甜点工作室'), row('示例家庭烘焙')], hash: 'h1' }, tableError = false } = {}) {
  const rpc = vi.fn(async (name: string) => name === 'report_document_data_source'
    ? { data: { sessionId: session, benchmarkHash: 'h1', generatedBody: body, storedData: null, ...source }, error: null }
    : tableError ? { data: null, error: { message: 'RESEARCH_SESSION_REQUIRED' } } : { data: table, error: null });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}
const draft = (value = body, manuallyEdited = false) => ({ body: value, finalized: false, manuallyEdited });

describe('reportStrategy', () => {
  it('reads nothing for a report without a data block', async () => {
    const f = admin();
    expect(await reportStrategy(f.client, actor, execution, draft(text))).toBeNull();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('fills benchmark numbers from the host table while it is the frozen one', async () => {
    const f = admin();
    const result = (await reportStrategy(f.client, actor, execution, draft()))!;
    expect(f.rpc).toHaveBeenCalledWith('research_benchmark_rows', { a: actor, s: session });
    expect(result.data.data.benchmarks!.accounts[0]).toMatchObject({ account: '示例甜点工作室',
      metrics: { followers: 18000, medianViews: 4200, engagementRate: 0.05, weeklyPosts: 3 } });
    expect(result.data.data.funnel).toEqual(SAMPLE_REPORT_DATA.funnel);
    expect(result.textEdited).toEqual([]);
  });

  it('shows no numbers once the table was refreshed or cannot be read, and none of the model\'s accounts without a table', async () => {
    const refreshed = (await reportStrategy(admin({ table: { rows: [row('示例甜点工作室')], hash: 'h2' } }).client, actor, execution, draft()))!;
    expect(refreshed.data.data.benchmarks!.accounts.map(account => 'metrics' in account && account.metrics)).toEqual([null, null]);
    const gone = (await reportStrategy(admin({ tableError: true }).client, actor, execution, draft()))!;
    expect(gone.data.data.benchmarks!.accounts).toHaveLength(2);
    const none = (await reportStrategy(admin({ source: { benchmarkHash: null } }).client, actor, execution, draft()))!;
    expect(none.data.data.benchmarks!.accounts).toEqual([]);
    expect(none.data.dropped).toEqual(['benchmarks.accounts[0]', 'benchmarks.accounts[1]']);
  });

  it('marks the fields of chapters whose text the user changed, and only those', async () => {
    const edited = body.replace('三层。', '改成两层。');
    const result = (await reportStrategy(admin().client, actor, execution, draft(edited, true)))!;
    expect(result.textEdited).toEqual(['funnel', 'upgrades', 'income']);
  });

  it('answers a finalized report with what 定稿 stored', async () => {
    const storedData = { dataVersion: 1, validatedAt: '2026-10-20T00:00:00Z', dropped: ['topics[1]'],
      data: { summary: '定稿时的数据' }, textEdited: ['summary'] };
    const f = admin({ source: { storedData } });
    const result = (await reportStrategy(f.client, actor, execution, { body, finalized: true, manuallyEdited: true }))!;
    expect(result).toMatchObject({ stored: true, textEdited: ['summary'], data: { data: { summary: '定稿时的数据' }, dropped: ['topics[1]'] } });
    expect(f.rpc).not.toHaveBeenCalledWith('research_benchmark_rows', expect.anything());
  });

  it('binds what 定稿 stores to the body hash', () => {
    expect(storedReportData(null, 'a'.repeat(64))).toBeNull();
  });
});
