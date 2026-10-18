/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type {AgentToolEvent} from '../../shared/agentWork';
import type {RuntimeTool} from './runner';

const record = (value: unknown): Record<string, unknown> =>
 value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';

/** Only host labels and names of the user's own files leave the server, never source text or model arguments. */
export function sourceWorkSummary(result: unknown): Pick<AgentToolEvent, 'kind' | 'state' | 'label' | 'detail'> | null {
 const value = record(result), identity = record(value.identity);
 if (value.kind === 'my_posts') {
  const days = [14, 30, 90].includes(value.window_days as number) ? value.window_days : null;
  const base = {kind: 'my_posts' as const};
  if (value.status === 'not_connected') return {...base, state: 'missing', label: '未取到：还没有连接账号'};
  if (value.status === 'no_entitlement') return {...base, state: 'missing',
   label: '读你的作品数据是 Pro/Gold 会员功能，这次先按定位和资料回答'};
  if (value.status === 'no_recent_posts' && days) return {...base, state: 'missing', label: `最近 ${days} 天没有新作品`};
  if (value.status === 'stale') return {...base, state: 'pending', label: typeof value.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.as_of)
   ? `数据截至 ${value.as_of}，最近一次快照已超过 3 天。` : '还没有取到作品快照，指标未取到。'};
  if (value.status === 'available' && days && Array.isArray(value.posts))
   return {...base, state: 'done', label: `读了你最近 ${days} 天的 ${value.posts.length} 条作品`};
  return {...base, state: 'pending', label: '作品数据待核实'};
 }

 if (value.kind === 'workspace_source' && identity.kind === 'positioning')
  return {kind: 'positioning', state: 'done', label: '读了你确认的定位', detail: text(identity.name, 80)};
 if (value.kind === 'workspace_source' && identity.kind === 'benchmarks')
  return {kind: 'my_benchmarks', state: 'done', label: '看了你的对标账号数据'};
 if (value.kind === 'library_segment')
  return {kind: 'library_read', state: 'done', label: '读了一段资料', detail: text(value.title, 80)};
 if (value.kind === 'library_search') {
  const docs = new Map<string, string>();
  for (const hit of Array.isArray(value.hits) ? value.hits : []) {
   const row = record(hit);
   if (typeof row.documentId === 'string') docs.set(row.documentId, text(row.title, 60) || '（未命名）');
  }
  return docs.size ? {kind: 'library_search', state: 'done', label: `在资料库里找到 ${docs.size} 篇相关内容`,
   detail: [...docs.values()].sort().join('、').slice(0, 120)}
   : {kind: 'library_search', state: 'missing', label: '资料库里没找到相关内容',
    detail: ('搜索词：' + (Array.isArray(value.terms) ? value.terms.filter(v => typeof v === 'string').join(' ') : '')).slice(0, 120)};
 }
 return null;
}

/** The journal and its visibility fences run unchanged; progress never changes execution or billing. */
export function withSourceWorkProgress(tool: RuntimeTool, emit?: (event: AgentToolEvent) => void, ownPosts = false): RuntimeTool {
 if (tool.name !== 'read_source' || !emit) return tool;
 return {...tool, execute: async (args, callId) => {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const kind = ownPosts && ['my_posts', 'my_posts:14', 'my_posts:30', 'my_posts:90'].includes(query) ? 'my_posts'
   : query.startsWith('search:') ? 'library_search' : /^doc-\d+\/segment-\d+$/.test(query) ? 'library_read' : null;
  const event = {type: 'agent_tool' as const, callId, tool: 'read_source' as const};
  const send = (summary: Omit<AgentToolEvent, 'type' | 'callId' | 'tool'>) => {
   try {emit({...event, ...summary});} catch { /* Display disconnect never interrupts source persistence. */ }
  };
  if (kind) send({kind, state: 'running', label: ''});
  let result: string;
  try {result = await tool.execute(args, callId);}
  catch (error) {
   if (kind) send({kind, state: 'pending', label: kind === 'my_posts' ? '作品读取待核实' : '资料读取待核实'});
   throw error;
  }
  let summary: ReturnType<typeof sourceWorkSummary>;
  try {
   const parsed = JSON.parse(result);
   summary = kind === 'my_posts' && parsed?.kind === 'unavailable' && parsed.reason === 'capacity_exhausted'
    ? {kind, state: 'missing', label: '资料太多放不下，先按已读到的回答'} : sourceWorkSummary(parsed);
  }
  catch {
   if (kind) send({kind, state: 'pending', label: kind === 'my_posts' ? '作品读取待核实' : '资料读取待核实'});
   return result;
  }
  if (summary) send(summary);
  else if (kind) send({kind, state: 'missing', label: kind === 'my_posts' ? '未取到作品数据' : '未取到相关资料'});
  return result;
 }};
}
