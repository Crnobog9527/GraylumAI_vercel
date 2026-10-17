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
  it('binds one subcall and only reserves on open; dispatch and cancel are separate steps (#1005 P2)', async () => {
    const { store, rpc } = harness([{}, { claimed: true, token: 'token' }, {}, { dispatch: true }, {}, {}]);
    const evidence = store.evidence('discovery');
    expect(await evidence.open('operation', 'identity', 2000)).toEqual({ token: 'token' });
    expect(rpc.mock.calls).toEqual([
      ['research_runtime_plan_create', { a: 'actor', p_plan: 'operation', s: 'session', e: 'answer', p_discovery: 'discovery',
        p_payload: { budgetUnits: 2000, maxOperations: 1,
          operations: [{ operationId: 'operation', identityHash: 'identity', maxQuoteUnits: 2000 }] } }],
      ['research_transition', { p_action: 'reserve', p_plan_id: 'operation', p_actor_id: 'actor',
        p_operation_id: 'operation', p_payload: { identityHash: 'identity', quoteUnits: 2000 } }],
    ]);
    await evidence.link('operation', 'call');
    expect(await evidence.dispatch('operation', 'token')).toBe(true);
    await evidence.finish('operation', 'token', 'succeeded', { cost: { actual: 0.002 } });
    await evidence.cancel('operation');
    expect(rpc.mock.calls.slice(2)).toEqual([
      ['research_runtime_link', { a: 'actor', p_plan: 'operation', s: 'session',
        e: 'answer', p_discovery: 'discovery', p_operation: 'operation', p_call: 'call' }],
      ['research_transition', { p_action: 'dispatch', p_plan_id: 'operation', p_actor_id: 'actor',
        p_operation_id: 'operation', p_payload: { token: 'token' } }],
      ['research_transition', expect.objectContaining({
        p_action: 'finish', p_payload: { token: 'token', state: 'succeeded', result: { cost: { actual: 0.002 } } } })],
      ['research_transition', { p_action: 'cancel', p_plan_id: 'operation', p_actor_id: 'actor',
        p_operation_id: 'operation', p_payload: {} }],
    ]);
  });
  it('closes a dispatched operation with no result and no BILL2 link as unsent (#1005 P2)', async () => {
    const { store, rpc } = harness([{ state: 'dispatched', result: null }, true, { state: 'dispatched', result: null }, false]);
    expect(await store.readOperation('stuck')).toEqual({ state: 'cancelled', result: null });
    expect(rpc.mock.calls[1]).toEqual(['research_runtime_close_unsent', { a: 'actor', s: 'session', p_operation: 'stuck' }]);
    // A linked (possibly sent) operation stays dispatched: never resent.
    expect(await store.readOperation('linked')).toEqual({ state: 'dispatched', result: null });
  });
  it('reads one settled call charge of this answer only, through the scoped 0267 RPC', async () => {
    const { store, rpc } = harness([{ source: 'tool_usage', credits: '1.25' }, null, { credits: 'NaN' }]);
    expect(await store.callCharge('call')).toBe('1.25');
    expect(rpc.mock.calls[0]).toEqual(['research_runtime_call_charge', { a: 'actor', s: 'session', e: 'answer', p_call: 'call' }]);
    expect(await store.callCharge('foreign')).toBeNull();
    await expect(store.callCharge('bad')).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
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

describe('saved research receipt recovery', () => {
  const runId = '00000000-0000-4000-8000-000000000001';
  const callId = '00000000-0000-4000-8000-000000000002';
  const receipt = { evidenceKind: 'tool_result', providerId: callId, cost: '0.0123', sourceHash: 'a'.repeat(64),
    usage: { unit: 'call', units: '1' }, toolOutcome: 'delivered' };
  const result = { items: [{ fields: { title: 'private until recovery' } }], billing: { runId, callId, receipt } };
  const operation = { state: 'succeeded', result };
  const plan = { executionId: 'original-answer', discoveryId: 'original-discovery', operations: [] };

  it('validates the original binding before recording on the original run, then returns content', async () => {
    const { store, rpc } = harness([operation, plan, null, { accountClosed: false, contentDeleted: false }]);
    expect(await store.readOperation('operation')).toEqual(operation);
    expect(rpc.mock.calls).toEqual([
      ['research_runtime_read', { a: 'actor', s: 'session', e: 'answer', p_kind: 'operation', p_id: 'operation' }],
      ['research_runtime_read', { a: 'actor', s: 'session', e: 'answer', p_kind: 'plan', p_id: 'operation' }],
      ['research_runtime_link', { a: 'actor', p_plan: 'operation', s: 'session', e: 'original-answer',
        p_discovery: 'original-discovery', p_operation: 'operation', p_call: callId }],
      ['bill2_record', { p_actor_id: 'actor', p_run_id: runId, p_call_id: callId, p_evidence: receipt }],
    ]);
  });
  it('repeats the exact same receipt on subsequent recovery without sending another supplier request', async () => {
    const { store, rpc } = harness([operation, plan, null, {}, operation, plan, null, {}]);
    expect(await store.readOperation('operation')).toEqual(operation);
    expect(await store.readOperation('operation')).toEqual(operation);
    const records = rpc.mock.calls.filter(([name]) => name === 'bill2_record');
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(records[1]);
    expect(records[0][1].p_evidence).toEqual(receipt);
  });
  it('accepts only a saved free failure with the exact database unsent verdict', async () => {
    const freeReceipt = { ...receipt, toolOutcome: 'failed_free', cost: '0' };
    const prior = { state: 'failed', result: { outcome: 'not_sent', items: [],
      billing: { runId, callId, receipt: freeReceipt } } };
    const { store, rpc } = harness([prior, plan, null, new Error('BILL2_CALL_NOT_DISPATCHED')]);
    expect(await store.readOperation('operation')).toEqual(prior);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'research_runtime_read', 'research_runtime_read', 'research_runtime_link', 'bill2_record',
    ]);
    expect(rpc.mock.calls[3][1]).toEqual({ p_actor_id: 'actor', p_run_id: runId,
      p_call_id: callId, p_evidence: freeReceipt });
  });
  it.each([
    ['delivered', 'BILL2_CALL_NOT_DISPATCHED'],
    ['unknown', 'BILL2_CALL_NOT_DISPATCHED'],
    ['failed_charged', 'BILL2_CALL_NOT_DISPATCHED'],
    ['failed_free', 'prefix BILL2_CALL_NOT_DISPATCHED'],
    ['failed_free', 'BILL2_CALL_NOT_DISPATCHED suffix'],
    ['failed_free', 'BILL2_DATABASE_UNAVAILABLE'],
  ])('refuses the unsent exception for outcome %s and error %s', async (toolOutcome, message) => {
    const prior = { ...operation, result: { ...result, billing: { runId, callId, receipt: { ...receipt, toolOutcome } } } };
    const { store } = harness([prior, plan, null, new Error(message)]);
    await expect(store.readOperation('operation')).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
  });
  it('does not mistake an unsent error from binding validation for billing proof', async () => {
    const prior = { ...operation, result: { ...result,
      billing: { runId, callId, receipt: { ...receipt, toolOutcome: 'failed_free' } } } };
    const { store, rpc } = harness([prior, plan, new Error('BILL2_CALL_NOT_DISPATCHED')]);
    await expect(store.readOperation('operation')).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it.each(['failed', 'unknown'])('recovers the receipt for a %s terminal result too', async state => {
    const prior = { ...operation, state };
    const { store, rpc } = harness([prior, plan, null, {}]);
    expect(await store.readOperation('operation')).toEqual(prior);
    expect(rpc.mock.calls[3][0]).toBe('bill2_record');
  });
  it.each([
    [operation, null],
    [operation, new Error('ownership denied')],
    [operation, plan, new Error('hash or original call mismatch')],
    [operation, plan, null, new Error('record failed')],
    [operation, plan, null, null],
    [operation, plan, null, { contentDeleted: 'invalid' }],
  ])('never returns content when scoped validation or receipt recording fails (%j)', async (...responses) => {
    const { store } = harness(responses);
    await expect(store.readOperation('operation')).rejects.toThrow();
  });
  it.each([{ accountClosed: true }, { contentDeleted: true }])('withholds content after erasure: %j', async view => {
    const { store } = harness([operation, plan, null, view]);
    await expect(store.readOperation('operation')).rejects.toThrow('CONTENT_ERASED');
  });
  it.each([
    { ...operation, resultAccess: 'restricted' },
    { ...operation, state: 'dispatched' },
    { ...operation, result: { ...result, billing: null } },
    { ...operation, result: { ...result, billing: { runId: 'wrong', callId, receipt } } },
  ])('fails closed for restricted or malformed saved receipts (%j)', async prior => {
    const { store, rpc } = harness([prior]);
    await expect(store.readOperation('operation')).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([{ items: [] }, { outcome: 'failed' }])('withholds terminal supplier results without a saved receipt (%j)', async result => {
    const { store, rpc } = harness([{ state: 'succeeded', result }]);
    await expect(store.readOperation('old')).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('preserves empty and nonterminal reads without inventing receipts', async () => {
    const old = { state: 'dispatched', result: null };
    const { store, rpc } = harness([old, false, null]);
    expect(await store.readOperation('old')).toEqual(old);
    expect(await store.readOperation('missing')).toBeNull();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['research_runtime_read', 'research_runtime_close_unsent',
      'research_runtime_read']);
  });
});
