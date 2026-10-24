/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const s = vi.hoisted(() => ({ rpcs: [] as Array<[string, Record<string, unknown>]>, context: null as unknown, workspace: false,
  sources: {} as Record<string, unknown> }));
vi.mock('./compareAdmission', () => ({
  compareRpc: async (_admin: unknown, name: string, args: Record<string, unknown>) => {
    s.rpcs.push([name, args]);
    if (name === 'fusion_compare_context') return s.context;
    if (name === 'runtime_workspace_source') return s.sources[String(args.p_query)];
    throw new Error('unexpected ' + name);
  },
}));
vi.mock('../runtime/workspacePosts', () => ({ readWorkspaceCapability: async () => s.workspace }));
import { fitHistory, historyTurn, loadCompareChoice } from './compareLoad';
import { FUSION_INPUT_CAP } from './request';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
// The profile read of the reply language (Owner 2026-10-24); null means none set.
let replyLanguage: string | null = null;
const profileRead = { select: () => profileRead, eq: () => profileRead, single: async () => ({ data: { reply_language: replyLanguage }, error: null }) };
const admin = { from: (table: string) => { expect(table).toBe('profiles'); return profileRead; } } as unknown as SupabaseClient;
const load = (patch = {}) => loadCompareChoice({ admin, user: {} as SupabaseClient, actorId: id(1) },
  { sessionId: id(2), question: '哪个好？', modelIds: [id(3), id(4)], ...patch });

beforeEach(() => {
  s.rpcs = []; s.workspace = false; s.sources = {}; replyLanguage = null;
  s.context = { revision: 4, busy: false, materialRevision: 'm-4', scopeMaterial: null,
    items: [{ revision: 1, item: user('第一问') }, { revision: 2, item: { type: 'function_call', name: 'search' } },
      { revision: 3, item: assistant('第一答') }] };
});

describe('compare loading (FUSION-COMPARE §3.2)', () => {
  it('keeps only visible user and assistant text from stored history items', () => {
    expect(historyTurn(user('问'))).toEqual({ role: 'user', text: '问' });
    expect(historyTurn({ role: 'user', content: [{ type: 'input_text', text: '甲' }, { type: 'input_text', text: '乙' }] }))
      .toEqual({ role: 'user', text: '甲乙' });
    expect(historyTurn(assistant('答'))).toEqual({ role: 'assistant', text: '答' });
    expect(historyTurn({ type: 'function_call_result', output: 'x' })).toBeNull();
    expect(historyTurn({ role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }] })).toBeNull();
  });

  it('reads history, revision and work material from the one context read, with no Skill and no workspace', async () => {
    const choice = await load();
    expect(s.rpcs[0]).toEqual(['fusion_compare_context', { p_actor_id: id(1), p_session_id: id(2), p_limit: 200 }]);
    expect(choice).toMatchObject({ sessionId: id(2), historyRevision: 4, materialRevision: 'm-4', modelIds: [id(3), id(4)] });
    expect(choice.parts).toMatchObject({ skill: null, positioningFallback: false, workspace: [], references: [], question: '哪个好？',
      history: [{ role: 'user', text: '第一问' }, { role: 'assistant', text: '第一答' }], replyLocale: 'zh-Hans' });
  });

  it('freezes the language set in the profile into the snapshot', async () => {
    replyLanguage = 'en';
    expect((await load()).parts.replyLocale).toBe('en');
    replyLanguage = 'zh-Hant';
    expect((await load()).parts.replyLocale).toBe('zh-Hant');
  });

  it('refuses while a turn of the main conversation is running', async () => {
    s.context = { ...(s.context as object), busy: true };
    await expect(load()).rejects.toThrow('FUSION_COMPARE_SESSION_BUSY');
  });

  it('freezes the confirmed positioning and account strategies, with their source versions, and nothing else', async () => {
    s.workspace = true;
    s.sources = { '': { kind: 'workspace_index', entries: [{ id: 'p1', kind: 'positioning' }, { id: 't1', kind: 'topic' },
      { id: 'a1', kind: 'strategy' }, { id: 'gone', kind: 'positioning' }] },
    p1: { kind: 'workspace_source', body: '定位正文', dependencies: [id(7)] },
    a1: { kind: 'workspace_source', body: { platform: 'x' }, dependencies: [id(8)] },
    gone: { kind: 'unavailable', dependencies: [] } };
    const choice = await load();
    expect(choice.parts.workspace).toEqual([{ sourceVersionId: id(7), kind: 'positioning', body: '定位正文' },
      { sourceVersionId: id(8), kind: 'strategy', body: '{"platform":"x"}' }]);
    expect(s.rpcs.map(([name, args]) => name === 'runtime_workspace_source' ? args.p_query : name))
      .toEqual(['fusion_compare_context', '', 'p1', 'a1', 'gone']);
  });

  it('drops the oldest turns until the request fits the per-call cap, never the question', () => {
    const big = 'x'.repeat(30000);
    const parts = { skill: null, positioningFallback: false, scopeMaterial: undefined, workspace: [], references: [], question: '问题',
      replyLocale: 'zh-Hans' as const,
      history: [{ role: 'user' as const, text: big }, { role: 'assistant' as const, text: big }, { role: 'user' as const, text: big },
        { role: 'assistant' as const, text: 'short' }] };
    const fitted = fitHistory(parts);
    expect(fitted.history.length).toBeLessThan(4);
    expect(fitted.history.at(-1)).toEqual({ role: 'assistant', text: 'short' });
    expect(fitted.question).toBe('问题');
    expect(JSON.stringify(fitted.history).length).toBeLessThan(FUSION_INPUT_CAP);
  });
});
