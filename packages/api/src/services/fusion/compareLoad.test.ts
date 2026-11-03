/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const s = vi.hoisted(() => ({ rpcs: [] as Array<[string, Record<string, unknown>]>, workspace: false, sources: {} as Record<string, unknown> }));
vi.mock('./compareAdmission', () => ({
  compareRpc: async (_admin: unknown, name: string, args: Record<string, unknown>) => {
    s.rpcs.push([name, args]);
    if (name === 'runtime_workspace_source') return s.sources[String(args.p_query)];
    throw new Error('unexpected ' + name);
  },
}));
vi.mock('../turn/agent/workspacePosts', () => ({ readWorkspaceCapability: async () => s.workspace }));
import { loadCompareTurnParts } from './compareLoad';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// The profile read of the reply language (Owner 2026-10-24); null means none set.
let replyLanguage: string | null = null;
const profileRead = { select: () => profileRead, eq: () => profileRead, single: async () => ({ data: { reply_language: replyLanguage }, error: null }) };
const admin = { from: (table: string) => { expect(table).toBe('profiles'); return profileRead; } } as unknown as SupabaseClient;
const load = () => loadCompareTurnParts({ admin, user: {} as SupabaseClient, actorId: id(1) }, { sessionId: id(2), question: '哪个好？' });

beforeEach(() => { s.rpcs = []; s.workspace = false; s.sources = {}; replyLanguage = null; });

describe('compare loading on the turn path (FUSION-COMPARE §3.2)', () => {
  it('reads nothing but the question, the language and the workspace: no Skill, no history, no references', async () => {
    const parts = await load();
    expect(parts).toEqual({ skill: null, workspace: [], references: [], question: '哪个好？', replyLocale: 'zh-Hans' });
    expect(s.rpcs).toEqual([]);
  });

  it('freezes the language set in the profile', async () => {
    replyLanguage = 'en';
    expect((await load()).replyLocale).toBe('en');
    replyLanguage = 'zh-Hant';
    expect((await load()).replyLocale).toBe('zh-Hant');
  });

  it('freezes the confirmed positioning and account strategies, with their source versions, and nothing else', async () => {
    s.workspace = true;
    s.sources = { '': { kind: 'workspace_index', entries: [{ id: 'p1', kind: 'positioning' }, { id: 't1', kind: 'topic' },
      { id: 'a1', kind: 'strategy' }, { id: 'gone', kind: 'positioning' }] },
    p1: { kind: 'workspace_source', body: '定位正文', dependencies: [id(7)] },
    a1: { kind: 'workspace_source', body: { platform: 'x' }, dependencies: [id(8)] },
    gone: { kind: 'unavailable', dependencies: [] } };
    const parts = await load();
    expect(parts.workspace).toEqual([{ sourceVersionId: id(7), kind: 'positioning', body: '定位正文' },
      { sourceVersionId: id(8), kind: 'strategy', body: '{"platform":"x"}' }]);
    expect(s.rpcs.map(([name, args]) => name === 'runtime_workspace_source' ? args.p_query : name)).toEqual(['', 'p1', 'a1', 'gone']);
  });
});
