/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { databaseRuntimeResearchStore } from './store';

const scope = { userId: 'actor', sessionId: 'session', executionId: 'answer' };
function harness(responses: unknown[] = []) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    void _name; void _args;
    const value = responses.shift();
    return value instanceof Error ? { data: null, error: value } : { data: value ?? null, error: null };
  });
  const from = vi.fn(() => { throw new Error('Direct table reads forbidden'); });
  const store = databaseRuntimeResearchStore({ admin: { rpc }, db: { from } as unknown as SupabaseClient, scope });
  return { store, rpc, from };
}

describe('runtime research storage boundary', () => {
  it('binds one subcall before reserving and dispatching; preserves micro-USD / USD units', async () => {
    const { store, rpc } = harness([{}, { claimed: true, token: 'token' }, { dispatch: true }, {}, {}]);
    const evidence = store.evidence('discovery');
    expect(await evidence.open('operation', 'identity', 2000)).toEqual({ token: 'token' });
    expect(rpc.mock.calls).toEqual([
      ['research_runtime_plan_create', { a: 'actor', p_plan: 'operation', s: 'session', e: 'answer', p_discovery: 'discovery',
        p_payload: { budgetUnits: 2000, maxOperations: 1,
          operations: [{ operationId: 'operation', identityHash: 'identity', maxQuoteUnits: 2000 }] } }],
      ['research_transition', { p_action: 'reserve', p_plan_id: 'operation', p_actor_id: 'actor',
        p_operation_id: 'operation', p_payload: { identityHash: 'identity', quoteUnits: 2000 } }],
      ['research_transition', { p_action: 'dispatch', p_plan_id: 'operation', p_actor_id: 'actor',
        p_operation_id: 'operation', p_payload: { token: 'token' } }],
    ]);
    await evidence.finish('operation', 'token', 'succeeded', { cost: { actual: 0.002 } });
    await evidence.link('operation', 'call');
    expect(rpc.mock.calls[3]).toEqual(['research_transition', expect.objectContaining({
      p_payload: { token: 'token', state: 'succeeded', result: { cost: { actual: 0.002 } } },
    })]);
    expect(rpc.mock.calls[4]).toEqual(['research_runtime_link', { a: 'actor', p_plan: 'operation', s: 'session',
      e: 'answer', p_discovery: 'discovery', p_operation: 'operation', p_call: 'call' }]);
  });
  it('does not dispatch a replay or a denied reservation', async () => {
    const { store, rpc } = harness([{}, { claimed: false, state: 'unknown' }]);
    expect(await store.evidence().open('operation', 'identity', 0)).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(['research_runtime_plan_create', expect.objectContaining({
      p_payload: expect.objectContaining({ budgetUnits: 1 }),
    })]);
  });
  it('rejects mismatched callers before reading confirmations or refreshes', async () => {
    const { store, rpc, from } = harness();
    const wrong = { ...scope, sessionId: 'other' };
    expect(await store.authorization.keywordConfirmation(wrong, 'id')).toBeNull();
    expect(await store.authorization.candidateConfirmation(wrong, 'id')).toBeNull();
    expect(await store.authorization.userMessage(wrong, 'id')).toBeNull();
    expect(await store.authorization.refreshGrant(wrong, 'id')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
  it('uses the database verdict for a refresh grant prepared recovery', async () => {
    const { store, rpc, from } = harness([{ platform: 'tiktok', account: '@Alice', used: false }]);
    expect(await store.authorization.refreshGrant(scope, 'grant')).toEqual({ platform: 'tiktok', account: 'alice', used: false });
    expect(rpc).toHaveBeenCalledWith('research_runtime_read', {
      a: 'actor', s: 'session', e: 'answer', p_kind: 'refresh', p_id: 'grant',
    });
    expect(from).not.toHaveBeenCalled();
  });
  it('preserves a used refresh refusal', async () => {
    const { store } = harness([{ platform: 'tiktok', account: 'alice', used: true }]);
    expect(await store.authorization.refreshGrant(scope, 'grant')).toEqual({ platform: 'tiktok', account: 'alice', used: true });
  });
  it('does not reveal discovery data when its scoped read fails', async () => {
    const { store } = harness([new Error('RESEARCH_SCOPE_DENIED')]);
    await expect(store.discoveryRead('discovery')).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
  });
  it('does not confirm a card outside the requested session', async () => {
    const { store, rpc } = harness([null]);
    await expect(store.confirmCard('card', { selected: ['a'] })).rejects.toThrow('RESEARCH_SCOPE_DENIED');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('research_runtime_read', {
      a: 'actor', s: 'session', e: 'answer', p_kind: 'card', p_id: 'card',
    });
  });
  it('sends immutable attempt tokens and refresh identity to the owning RPCs', async () => {
    const { store, rpc } = harness([{ claimed: true, fetchId: 'fetch', attempt: 'attempt' }, true, {}]);
    await store.fetchClaim('tiktok', 'alice', 'grant');
    await store.fetchDispatch('fetch', 'attempt');
    await store.fetchFinish('fetch', 'attempt', 'failed_charged', { cost: 1 });
    expect(rpc.mock.calls).toEqual([
      ['research_account_fetch_claim', { a: 'actor', s: 'session', e: 'answer', p_platform: 'tiktok', p_account: 'alice', p_refresh: 'grant' }],
      ['research_account_fetch_dispatch', { a: 'actor', p_fetch: 'fetch', p_attempt: 'attempt' }],
      ['research_account_fetch_finish', { a: 'actor', p_fetch: 'fetch', p_attempt: 'attempt', p_state: 'failed_charged', p_evidence: { cost: 1 } }],
    ]);
  });
});
