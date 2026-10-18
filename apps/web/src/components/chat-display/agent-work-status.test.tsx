/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentWorkStatus } from './agent-work-status';
import { RUNNING_LABELS, workItemFromResearchCall, workItemLine, workItemsOf, streamedWorkItems, type WorkItem } from './agent-work-model';
import * as W from './fixtures/work-status';
import type { ResearchCall } from '@/components/research/research-model';

const call = (state: ResearchCall['state'], credits?: string | null): ResearchCall => ({
  callId: 'c1', toolName: 'social_account', args: {}, query: '@某博主', platform: 'xiaohongshu', dataKind: 'account_posts',
  state, credits,
});

describe('AgentWorkStatus', () => {
  it('renders nothing without rows', () => {
    expect(renderToStaticMarkup(<AgentWorkStatus items={[]}/>)).toBe('');
  });

  it('shows finished rows with their details and credits, and no supplier or dollar text', () => {
    const html = renderToStaticMarkup(<AgentWorkStatus items={W.SAMPLE_WORK_ITEMS_DONE}/>);
    for (const text of ['AI 教练的工作记录', '读了你确认的定位', '在资料库里找到 3 篇相关内容', '门店菜单.docx',
      '读了你最近 14 天的 6 条作品', '看了 3 个对标账号', '扣 1.2 积分']) expect(html).toContain(text);
    for (const text of ['TikHub', 'Parallel', 'Firecrawl', '$', '美元']) expect(html).not.toContain(text);
    expect(html).not.toContain('完成'); // a finished row needs no chip
  });

  it('is a polite live region so screen readers hear steps start and finish', () => {
    const html = renderToStaticMarkup(<AgentWorkStatus items={W.SAMPLE_WORK_ITEMS_RUNNING}/>);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="false"');
  });

  it('uses the running text while a step runs', () => {
    const html = renderToStaticMarkup(<AgentWorkStatus items={W.SAMPLE_WORK_ITEMS_RUNNING}/>);
    expect(html).toContain(RUNNING_LABELS.my_posts);
    expect(html).toContain('data-work-state="running"');
  });

  it('says plainly when there is nothing to read', () => {
    const html = renderToStaticMarkup(<AgentWorkStatus items={W.SAMPLE_WORK_ITEMS_EMPTY}/>);
    expect(html).toContain('还看不到你发布的作品数据');
    expect(html).toContain('这次没查到');
  });
});

describe('work rows', () => {
  it('maps research calls through the RT-5 wording', () => {
    expect(workItemFromResearchCall(call('running'))).toMatchObject({ kind: 'research', state: 'running', label: '搜索 @某博主' });
    expect(workItemLine(workItemFromResearchCall(call('running')))).toBe('正在搜索 @某博主…');
    const done = workItemFromResearchCall(call('succeeded', '1.25'));
    expect(done.state).toBe('done');
    expect(done.detail).toContain('小红书');
    expect(workItemFromResearchCall(call('failed')).state).toBe('missing');
    expect(workItemFromResearchCall(call('unknown')).state).toBe('pending');
  });

  it('falls back to the kind text for a running row without a label', () => {
    const row: WorkItem = { id: 'x', kind: 'library_search', state: 'running', label: '' };
    expect(workItemLine(row)).toBe('正在查资料库…');
  });

  it('keeps only live features for the landing page', () => {
    expect(W.sampleWorkItems(['positioning', 'library_search']).map(item => item.kind)).toEqual(['positioning', 'library_search']);
  });
});

describe('workItemsOf', () => {
  const good = {id: 'c1', kind: 'library_search', state: 'done', label: '在资料库里找到 2 篇相关内容', detail: 'Menu.md、Notes.md'};
  it('reads the rows a view attached to an answer', () => {
    expect(workItemsOf({executionId: 'a', workItems: [good]})).toEqual([{...good, credits: null}]);
  });
  it('drops malformed rows and anything that is not a list', () => {
    expect(workItemsOf(null)).toEqual([]);
    expect(workItemsOf({})).toEqual([]);
    expect(workItemsOf({workItems: 'x'})).toEqual([]);
    expect(workItemsOf({workItems: [null, 3, {...good, kind: 'secret'}, {...good, state: 'odd'}, {...good, id: ''}, {...good, label: 4}, good]}))
      .toEqual([{...good, credits: null}]);
  });
  it('keeps at most 12 rows', () => {
    expect(workItemsOf({workItems: Array.from({length: 20}, (_, i) => ({...good, id: 'c' + i}))})).toHaveLength(12);
  });
});

it('uses the saved projection after completion, and does not regress a finished poll to a live running state',()=>{
 const done:WorkItem={id:'c',kind:'library_search',state:'done',label:'找到资料'};
 const running:WorkItem={...done,state:'running',label:''};
 expect(streamedWorkItems({state:'running',workItems:[done]},[running])[0].state).toBe('done');
 expect(streamedWorkItems({state:'running',workItems:[]},[done])).toEqual([done]);
 expect(streamedWorkItems({state:'completed',workItems:[]},[done])).toEqual([]);
 expect(streamedWorkItems({state:'cancelled',workItems:[]},[done])).toEqual([]);
});
