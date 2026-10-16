/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { researchRefreshContext, withResearchRefresh } from './researchRefresh';
import { hostTurnContextSchema, hostTurnInput, RESEARCH_REFRESH_NOTE, type HostTurnContext } from '../runtime/hostTurn';
import { opcGenerate } from './answerCard';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('../research/vendors/config', () => ({ readResearchToolsConfig: async () => ({ config: { enabled: config.enabled } }) }));
const actor = '10000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000002';
const refreshId = '10000000-0000-4000-8000-000000000003';
const mentor = { purpose: 'mentor', researchRefreshId: refreshId };
const turn = { opening: false, stepSummary: false };
function admin(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => { void _name; void _args; return { data, error }; });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}
beforeEach(() => { config.enabled = true; });

describe('RT-3b PR-2 refresh grant in the message entry', () => {
  it('reads the grant as this user and this session only, and freezes the canonical account with fixed host text', async () => {
    const f = admin({ platform: 'tiktok', account: '@Alice', used: false });
    expect(await researchRefreshContext(f.db, actor, session, mentor, turn))
      .toEqual({ refreshId, platform: 'tiktok', account: 'alice', note: RESEARCH_REFRESH_NOTE });
    expect(f.rpc).toHaveBeenCalledWith('research_runtime_read',
      { a: actor, s: session, e: null, p_kind: 'refresh', p_id: refreshId });
  });

  it('does nothing without a refresh id', async () => {
    const f = admin(null);
    expect(await researchRefreshContext(f.db, actor, session, { purpose: 'mentor' }, turn)).toBeUndefined();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['another user, another session or a deleted answer (null)', null],
    ['an already used grant', { platform: 'tiktok', account: 'alice', used: true }],
  ])('refuses %s before any model call', async (_label, data) => {
    await expect(researchRefreshContext(admin(data).db, actor, session, mentor, turn))
      .rejects.toThrow('OPC_RESEARCH_REFRESH_INVALID');
  });

  it('maps a scope refusal to an invalid refresh and an operational failure to unavailable', async () => {
    await expect(researchRefreshContext(admin(null, { message: 'RESEARCH_SCOPE_DENIED' }).db, actor, session, mentor, turn))
      .rejects.toThrow('OPC_RESEARCH_REFRESH_INVALID');
    await expect(researchRefreshContext(admin(null, { message: 'connection reset' }).db, actor, session, mentor, turn))
      .rejects.toThrow('OPC_RESEARCH_UNAVAILABLE');
    await expect(researchRefreshContext(admin({ platform: 'myspace', account: 'a', used: false }).db, actor, session, mentor, turn))
      .rejects.toThrow('OPC_RESEARCH_UNAVAILABLE');
  });

  it.each([
    ['a step request', { purpose: 'step', researchRefreshId: refreshId }, turn],
    ['a host opening', mentor, { opening: true, stepSummary: false }],
    ['a step summary', mentor, { opening: false, stepSummary: true }],
  ])('refuses a refresh on %s without reading it', async (_label, request, kind) => {
    const f = admin({ platform: 'tiktok', account: 'alice', used: false });
    await expect(researchRefreshContext(f.db, actor, session, request, kind)).rejects.toThrow('OPC_RESEARCH_REFRESH_INVALID');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('refuses while the research tools are switched off', async () => {
    config.enabled = false;
    const f = admin({ platform: 'tiktok', account: 'alice', used: false });
    await expect(researchRefreshContext(f.db, actor, session, mentor, turn)).rejects.toThrow('OPC_RESEARCH_REFRESH_UNAVAILABLE');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('is trusted host context in the model input, and the entry rejects a malformed id', async () => {
    const base: HostTurnContext = { stepId: 'first', opening: false, checklist: [] };
    const refresh = { refreshId, platform: 'tiktok' as const, account: 'alice', note: RESEARCH_REFRESH_NOTE };
    const context = hostTurnContextSchema.parse(withResearchRefresh(base, refresh));
    expect(JSON.parse(hostTurnInput('again please', undefined, context)).hostTurnContext.researchRefresh).toEqual(refresh);
    expect(withResearchRefresh(base, undefined)).toBe(base);
    expect(hostTurnContextSchema.safeParse({ ...base, researchRefresh: { ...refresh, note: 'model text' } }).success).toBe(false);
    const request = { draftId: actor, requestId: session, stepId: 'first', input: 'x', purpose: 'mentor' };
    expect(opcGenerate.safeParse({ ...request, researchRefreshId: 'not-a-uuid' }).success).toBe(false);
    expect(opcGenerate.parse({ ...request, researchRefreshId: refreshId }).researchRefreshId).toBe(refreshId);
  });
});
