/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { WorkItem } from '../agent-work-model';

/**
 * Sample data for the coach's work rows (CHAT-AUTO-CONTEXT §4), shared by the landing page and the component tests.
 * Made-up example content only. A row stays out of the landing page until its feature passes acceptance
 * (CHAT-AUTO-CONTEXT §8): pick rows with `sampleWorkItems(kinds)`.
 */

export const SAMPLE_WORK_QUESTION = '那我这周要拍什么？';

export const SAMPLE_WORK_ITEMS_DONE: WorkItem[] = [
  { id: 'sample-work-positioning', kind: 'positioning', state: 'done', label: '读了你确认的定位', detail: '烘焙小店 · 小红书' },
  { id: 'sample-work-library', kind: 'library_search', state: 'done', label: '在资料库里找到 3 篇相关内容',
    detail: '门店菜单.docx、上月选题复盘.md、顾客常问问题.txt' },
  { id: 'sample-work-posts', kind: 'my_posts', state: 'done', label: '读了你最近 14 天的 6 条作品', detail: '数据截至 10-16' },
  { id: 'sample-work-benchmarks', kind: 'my_benchmarks', state: 'done', label: '看了 3 个对标账号', detail: '对标表 · 取数时间 10-12' },
  { id: 'sample-work-research', kind: 'research', state: 'done', label: '搜索 @某烘焙博主', detail: '小红书 · 近期作品', credits: '1.2 积分' },
];

/** The same rows mid-answer: the last one still running. */
export const SAMPLE_WORK_ITEMS_RUNNING: WorkItem[] = [
  ...SAMPLE_WORK_ITEMS_DONE.slice(0, 2),
  { id: 'sample-work-posts', kind: 'my_posts', state: 'running', label: '' },
];

/** When there is nothing to read: what the coach says instead of guessing. */
export const SAMPLE_WORK_ITEMS_EMPTY: WorkItem[] = [
  { id: 'sample-work-posts-empty', kind: 'my_posts', state: 'missing', label: '还看不到你发布的作品数据', detail: '还没有连接账号或导入表格' },
];

/** Only the rows whose feature is live, in sample order. */
export function sampleWorkItems(kinds: readonly WorkItem['kind'][], items: readonly WorkItem[] = SAMPLE_WORK_ITEMS_DONE): WorkItem[] {
  return items.filter(item => kinds.includes(item.kind));
}
