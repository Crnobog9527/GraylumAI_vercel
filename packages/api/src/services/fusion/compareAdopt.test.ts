/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const s = vi.hoisted(() => ({ rpcs: [] as string[], card: {} as Record<string, unknown>, window: vi.fn(), moduleRow: {} as Record<string, unknown> }));
vi.mock('./compareAdmission', () => ({
  compareRpc: async (_admin: unknown, name: string) => {
    s.rpcs.push(name);
    if (name === 'fusion_compare_read') return { sessionId: id(3), columns: [{ column: 0, modelId: id(9), body: '回答' }, { column: 1, modelId: id(8), body: '另一个' }] };
    if (name === 'fusion_compare_list') return [s.card];
    if (name === 'runtime_session_context') return { scope: { kind: 'free' } };
    throw new Error('unexpected ' + name);
  },
}));
vi.mock('../runtime/stagingPolicy', () => ({ loadStagingPolicy: (...args: unknown[]) => s.window(...args) }));
import { adoptCompare } from './compareAdopt';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: s.moduleRow, error: null }) }) }) }) } as unknown as SupabaseClient;
const card = (patch: Record<string, unknown> = {}) => ({ compareId: id(1), sessionId: id(3), question: '问', workspaceDependencies: [],
  config: { skill: null }, adoption: null, ...patch });
const input = { compareId: id(1), column: 0, requestId: id(5) };

beforeEach(() => { s.rpcs = []; s.window = vi.fn(async () => { throw new Error('RUNTIME_TEST_WINDOW_DENIED'); }); });

describe('compare adoption (FUSION-COMPARE §3.4)', () => {
  it('answers an adoption that was already written from the stored record, with no staging window needed', async () => {
    const adoption = { requestId: id(5), column: 0, executionId: id(7) };
    s.card = card({ adoption });
    expect(await adoptCompare({ admin, actorId: id(2) }, input)).toEqual({ state: 'adopted', adoption });
    expect(s.window).not.toHaveBeenCalled();
    expect(s.rpcs).not.toContain('fusion_compare_adopt');
  });
  it('refuses another request or another column after an adoption, as the database does', async () => {
    s.card = card({ adoption: { requestId: id(5), column: 0, executionId: id(7) } });
    await expect(adoptCompare({ admin, actorId: id(2) }, { ...input, requestId: id(6) })).rejects.toThrow('FUSION_COMPARE_ADOPTED');
    await expect(adoptCompare({ admin, actorId: id(2) }, { ...input, column: 1 })).rejects.toThrow('FUSION_COMPARE_REQUEST_CONFLICT');
  });
  it('refuses a module that was re-bound to another Skill since the compare started', async () => {
    s.window = vi.fn(async () => ({ expiresAt: new Date(Date.now() + 3_600_000).toISOString(), callPolicies: [] }));
    s.card = card({ config: { skill: { moduleId: id(10), skillId: id(11), revisionId: id(12) } } });
    s.moduleRow = { id: id(10), skill_id: id(99), model_id: id(9) };
    await expect(adoptCompare({ admin, actorId: id(2) }, input)).rejects.toThrow('FUSION_COMPARE_SKILL_MISMATCH');
    expect(s.rpcs).not.toContain('fusion_compare_adopt');
  });
});
