/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { answerText, fusionDatabase, fusionPolicy } from './fusionCalls';

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
    gCredits: 1680, minCredits: 1680, fixedCredits: 1500, stopLoss, decisionUpperUsd: '0.001' });
  expect(policy).toMatchObject({ uTurnUsd: 0.101000000001, gCredits: 1680, fixedCredits: 1500, uModelCredits: 60,
    limits: { model: 2, paidTools: 0, freeTools: 0, decisions: 1 }, historyItems: 0 });
  expect(answerText(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }))).toBe('hello');
  expect(answerText(JSON.stringify({ choices: [{ message: { content: '' } }] }))).toBeNull();
  expect(answerText('not json')).toBeNull();
});
