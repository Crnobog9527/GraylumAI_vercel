/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { answerText, breakerTripped, fusionAdmission, fusionDatabase, fusionPolicy } from './fusionCalls';

const stopLoss = { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 };
const tomb = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };

it('CORE-PATH-V2 V2-7b: the begins of a parallel group reach the database one after another, in sequence order', async () => {
  const arrived: number[] = [];
  let first = true;
  const write = { rpc: async (name: string, args: Record<string, unknown>) => {
    // The first begin is slow; the second must still wait for it (turn_call_begin takes consecutive sequences).
    if (name === 'turn_fusion_begin' && first) { first = false; await new Promise(r => setTimeout(r, 30)); }
    arrived.push(args.p_seq as number);
    return { data: { state: 'running', status: 'dispatched', ...tomb }, error: null };
  } };
  const calls = fusionDatabase({ write, read: write } as never, 'actor').calls(7, () => null);
  const begin = (seq: number) => calls.begin({ actorId: 'actor', turnId: 7, seq, callKind: 'model', modelId: 'm', toolName: null,
    paid: null, requestHash: 'h', upperUsd: '0.1', multiplier: '6' });
  await Promise.all([begin(1), begin(2), begin(3)]);
  expect(arrived).toEqual([1, 2, 3]);
});

it('CORE-PATH-V2 V2-7b: a receipt carries the judged answer; a deleted review stops the call like a tombstone', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const write = { rpc: async (_name: string, args: Record<string, unknown>) => { sent.push(args);
    return { data: { status: 'ok', creditsLow: false, productGone: true, ...tomb }, error: null }; } };
  const calls = fusionDatabase({ write, read: write } as never, 'actor').calls(7, () => ({ status: 'unusable',
    usage: { verdict: 'format_invalid' }, output: { phase: 'fusion_review', body: 'x', verdict: 'format_invalid' } }));
  const recorded = await calls.record({ actorId: 'actor', turnId: 7, seq: 2, status: 'ok', nominalUsd: '0.01', actualUsd: '0.01',
    usage: { inputTokens: 1 }, providerId: 'gen', payloadHash: 'p', raw: '{}' });
  expect(sent[0]).toMatchObject({ p_status: 'unusable', p_nominal_usd: null, p_usage: { inputTokens: 1, verdict: 'format_invalid' },
    p_output: { body: 'x' } });
  expect(recorded.sessionTombstoned).toBe(true);
});

it('CORE-PATH-V2 V2-7b: the frozen numbers of a fusion turn and the answer text of a receipt', () => {
  const policy = fusionPolicy({ q: '100', calls: [{ upperUsd: '0.1', multiplier: '6' }, { upperUsd: '0.000000000001', multiplier: '3' }],
    gCredits: 1680, minCredits: 1680, fixedCredits: 1500, stopLoss, decisionUpperUsd: '0.001',
    quotes: [{ modelId: 'm1', model: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '1' } }] });
  // Frozen for recovery (turn_recovery_claim): the model and its nominal prices by model id.
  expect(policy).toMatchObject({ models: { m1: 'anthropic/claude-sonnet-5.5' }, pricings: { m1: { prompt: '1' } } });
  expect(policy).toMatchObject({ uTurnUsd: 0.101000000001, gCredits: 1680, fixedCredits: 1500, uModelCredits: 60,
    limits: { model: 2, paidTools: 0, freeTools: 0, decisions: 1 }, historyItems: 0 });
  expect(answerText(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }))).toBe('hello');
  expect(answerText(JSON.stringify({ choices: [{ message: { content: '' } }] }))).toBeNull();
  expect(answerText('not json')).toBeNull();
});

it('CORE-PATH-V2 V2-7b: the old permission chain is read before the open, on the write connection, by the owner keys', async () => {
  const seen: Array<[string, Record<string, unknown>]> = [];
  const breaker = { noDeliveryCalls: 0, platformUsd: 0 };
  const write = { rpc: async (name: string, args: Record<string, unknown>) => {
    seen.push([name, args]);
    if (args.p_draft_id === 'archived') return { data: null, error: { message: 'OPC_BUSINESS_ARCHIVED' } };
    if (args.p_draft_id === 'erased') return { data: null, error: { message: 'CONTENT_ERASED' } };
    return { data: name === 'fusion_compare_turn_admit' ? { history: [], positioned: true, breaker }
      : { draftId: 'd', projectId: 'p', sessionId: 's', sourceVersionId: 'v', versionHash: 'h', materials: {}, breaker }, error: null };
  } };
  // That chain locks and keeps a memo: a read-only connection would refuse it.
  const read = { rpc: async () => { throw new Error('the read connection is not used'); } };
  const admission = fusionAdmission({ read, write } as never, 'actor');
  expect((await admission.compare('s', 12, [{ sourceVersionId: 'v' }])).positioned).toBe(true);
  expect(seen[0]).toEqual(['fusion_compare_turn_admit', { p_actor_id: 'actor', p_session_id: 's', p_limit: 12,
    p_dependencies: [{ sourceVersionId: 'v' }] }]);
  expect((await admission.reviewSource({ requestId: 'r', draftId: 'd', sourceVersionId: 'v' })).projectId).toBe('p');
  expect(seen[1]).toEqual(['fusion_review_turn_source', { p_actor_id: 'actor', p_request_id: 'r', p_draft_id: 'd',
    p_source_version_id: 'v' }]);
  // The refusal codes the old start and compare raised are kept.
  await expect(admission.reviewSource({ requestId: 'r', draftId: 'archived', sourceVersionId: 'v' })).rejects.toMatchObject({ code: 'OPC_BUSINESS_ARCHIVED' });
  await expect(admission.reviewSource({ requestId: 'r', draftId: 'erased', sourceVersionId: 'v' })).rejects.toMatchObject({ code: 'CONTENT_ERASED' });
});

it('CORE-PATH-V2 V2-7b: the 7-day breaker trips at either threshold', () => {
  const limits = { platformUsd: '2', noDeliveryCalls: 10 };
  expect(breakerTripped({ noDeliveryCalls: 9, platformUsd: '1.99' }, limits)).toBe(false);
  expect(breakerTripped({ noDeliveryCalls: 10, platformUsd: 0 }, limits)).toBe(true);
  expect(breakerTripped({ noDeliveryCalls: 0, platformUsd: 2 }, limits)).toBe(true);
});
