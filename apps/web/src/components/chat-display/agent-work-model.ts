/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT §4: the rows a free-chat reply shows while the coach reads the user's own material and data
// (docs/launch/tasks/CHAT-AUTO-CONTEXT.md). Pure functions only; research rows reuse the RT-5 mapping so the
// positioning page and the work conversation describe a search the same way. No supplier names, no US dollars.
import { describeCall, type ResearchCall } from '@/components/research/research-model';

export type WorkKind = 'positioning' | 'library_search' | 'library_read' | 'my_posts' | 'my_benchmarks' | 'research';
export type WorkState = 'running' | 'done' | 'missing' | 'pending';

export interface WorkItem {
  id: string;
  kind: WorkKind;
  state: WorkState;
  /** Main line once the step has finished, e.g. "在资料库里找到 3 篇相关内容". Running rows use RUNNING_LABELS. */
  label: string;
  /** Second line: file names, data kind, or why nothing came back. */
  detail?: string | null;
  /** Settled credits, already formatted (research rows only), e.g. "0.3 积分". */
  credits?: string | null;
}

/** What a step says while it runs. */
export const RUNNING_LABELS: Record<WorkKind, string> = {
  positioning: '正在读你的定位…',
  library_search: '正在查资料库…',
  library_read: '正在读资料…',
  my_posts: '正在读你最近的作品数据…',
  my_benchmarks: '正在看你的对标账号…',
  research: '正在查最新数据…',
};

export const STATE_LABELS: Record<Exclude<WorkState, 'running'>, string> = {
  done: '完成', missing: '这次没查到', pending: '待核',
};

/** One research call from the stream (`research_call`) as a work row. */
export function workItemFromResearchCall(call: ResearchCall): WorkItem {
  const view = describeCall(call);
  const state: WorkState = view.state === 'success' ? 'done' : view.state;
  return {
    id: call.callId,
    kind: 'research',
    state,
    label: view.query ? `搜索 ${view.query}` : '搜索',
    detail: [view.line, view.detail].filter(Boolean).join(' · '),
    credits: view.credits,
  };
}

/** The line a row shows: the running text while it runs, its own label after. */
export function workItemLine(item: WorkItem): string {
  if (item.state !== 'running') return item.label;
  return item.kind === 'research' && item.label ? `正在${item.label}…` : RUNNING_LABELS[item.kind];
}

const KINDS: readonly WorkKind[] = ['positioning', 'library_search', 'library_read', 'my_posts', 'my_benchmarks', 'research'];
const STATES: readonly WorkState[] = ['running', 'done', 'missing', 'pending'];
const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null);

const DATA_KINDS: readonly ResearchCall['dataKind'][] = ['keyword_posts', 'account_profile', 'account_posts', 'account_relation',
  'post_detail', 'account_search', 'web_search', 'web_fetch'];
const CALL_STATES: readonly ResearchCall['state'][] = ['running', 'succeeded', 'failed', 'unknown'];
/** The `research` object of a saved row as a research call; null when it is not well-formed. */
function researchCallOf(id: string, raw: unknown): ResearchCall | null {
  const value = (raw ?? {}) as Record<string, unknown>;
  const query = text(value.query, 200), platform = text(value.platform, 20);
  if (query === null || !platform || !DATA_KINDS.includes(value.dataKind as ResearchCall['dataKind'])
    || !CALL_STATES.includes(value.state as ResearchCall['state'])) return null;
  return { callId: id, toolName: text(value.toolName, 40) ?? '', args: {}, query, platform: platform as ResearchCall['platform'],
    dataKind: value.dataKind as ResearchCall['dataKind'], state: value.state as ResearchCall['state'],
    credits: text(value.credits, 40) };
}

/**
 * The work rows a view attaches to one answer (`workItems`, from runtime_work_items). Anything that is not a well-formed
 * row is dropped, so a malformed reply can never break the page.
 */
export function workItemsOf(execution: unknown): WorkItem[] {
  const rows = (execution as {workItems?: unknown} | null)?.workItems;
  if (!Array.isArray(rows)) return [];
  const items: WorkItem[] = [];
  for (const row of rows.slice(0, 12)) {
    const value = (row ?? {}) as Record<string, unknown>;
    const id = text(value.id, 256), label = text(value.label, 200);
    if (!id || label === null || !KINDS.includes(value.kind as WorkKind) || !STATES.includes(value.state as WorkState)) continue;
    // A saved research row (runtime_work_items) keeps its call facts nested under `research`; show it like the live row.
    const research = value.kind === 'research' ? researchCallOf(id, value.research) : null;
    if (research) { items.push(workItemFromResearchCall(research)); continue; }
    items.push({id, kind: value.kind as WorkKind, state: value.state as WorkState, label,
      detail: text(value.detail, 200), credits: text(value.credits, 40)});
  }
  return items;
}

/** Live rows fill the polling gap only while the saved execution is open. Closed history is authoritative. */
export function streamedWorkItems(execution: unknown, live?: readonly WorkItem[]): WorkItem[] {
  const saved = workItemsOf(execution);
  if (!['prepared', 'running', 'interrupted'].includes((execution as {state?: string})?.state ?? '')) return saved;
  const rows = new Map(saved.map(item => [item.id, item]));
  for (const item of live ?? []) {
    const prior = rows.get(item.id);
    if (!prior || item.state !== 'running' || prior.state === 'running') rows.set(item.id, item);
  }
  return [...rows.values()].slice(0, 12);
}
