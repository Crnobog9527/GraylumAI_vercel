/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { DECISIONS_MODEL, DECISIONS_URL, decide, decisionsClassifier, readPositioningGate, judgePositioning, openRouterKey,
  windowBoundKey }
  from './positioningGate';
import { isPositioningRefusal, POSITIONING_MARKER, POSITIONING_FALLBACK_INSTRUCTIONS } from './positioningFallback';
import { withPrimaryAddenda } from './primaryInstructions';
import { stagingProcedureError, StagingAccessError } from './stagingErrors';
import { isPositioningRequired, POSITIONING_REQUIRED } from '../../shared/positioningGate';

afterEach(() => vi.restoreAllMocks());
const answer = (noul: number, cost = 0.00002) => new Response(JSON.stringify({
  answers: { own_account_social_media_operations: { type: 'noul', noul } }, model: DECISIONS_MODEL,
  usage: { input_tokens: 300, output_tokens: 1, cost } }), { status: 200 });

it.each([[0.91, 'block'], [0.5, 'block'], [0.3, 'allow'], [0.2, 'allow'], [0.12, 'clear']] as const)('Decisions probability %s means %s', async (noul, verdict) => {
  const transport = vi.fn(async () => answer(noul));
  expect(await decide('KEY', '帮我想下周发什么', transport as never)).toBe(verdict);
  const [url, init] = transport.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toBe(DECISIONS_URL);
  expect(init.headers).toMatchObject({ Authorization: 'Bearer KEY' });
  const body = JSON.parse(String(init.body));
  expect(body).toMatchObject({ model: DECISIONS_MODEL, state: { user_message: '帮我想下周发什么' } });
  expect(body.questions.own_account_social_media_operations.type).toBe('noul');
  // No account identity is sent to the provider.
  expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
});

it('logs the platform-paid cost without user text', async () => {
  const info = vi.spyOn(logger, 'info');
  await decide('KEY', 'PRIVATE MESSAGE', vi.fn(async () => answer(0.9, 0.000031)) as never);
  const [, event, fields] = info.mock.calls.find(call => call[1] === 'positioning_gate_decision')!;
  expect(event).toBe('positioning_gate_decision');
  expect(fields).toMatchObject({ model: DECISIONS_MODEL, verdict: 'block', costUsd: 0.000031, inputTokens: 300 });
  expect(JSON.stringify(fields)).not.toContain('PRIVATE');
});

it('records the billed cost even when the answer itself is malformed', async () => {
  const info = vi.spyOn(logger, 'info');
  const malformed = new Response(JSON.stringify({ answers: { own_account_social_media_operations: { type: 'noul', noul: 7 } },
    usage: { input_tokens: 280, output_tokens: 1, cost: 0.000028 } }), { status: 200 });
  expect(await decide('KEY', 'x', vi.fn(async () => malformed) as never)).toBe('unavailable');
  expect(info.mock.calls.find(call => call[1] === 'positioning_gate_decision')![2])
    .toMatchObject({ verdict: 'unavailable', costUsd: 0.000028, inputTokens: 280, probability: null });
});

it.each([
  ['an HTTP error', async () => new Response('{"error":{"message":"secret"}}', { status: 503 })],
  ['a transport failure', async () => { throw new Error('network'); }],
  ['a timeout', async () => { throw new DOMException('timeout', 'TimeoutError'); }],
  ['a malformed answer', async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })],
  ['an out-of-range probability', async () => answer(3)],
])('treats %s as unavailable', async (_name, transport) => {
  expect(await decide('KEY', 'x', vi.fn(transport) as never)).toBe('unavailable');
});

it('reuses the admitted model row OpenRouter key and never calls without one', async () => {
  expect(openRouterKey({ provider: 'openai', api_endpoint: '', api_key: ' K1 ' })).toBe('K1');
  for (const row of [null, { provider: 'fixture', api_endpoint: null, api_key: 'K' },
    { provider: 'openai', api_endpoint: 'https://example.com/v1/chat/completions', api_key: 'K' },
    { provider: 'openai', api_endpoint: '', api_key: ' ' }, { provider: 'openai', api_endpoint: '' }])
    expect(openRouterKey(row)).toBeUndefined();
  const transport = vi.fn(async () => answer(0.1));
  expect(await decisionsClassifier(transport as never)({ text: 'x', apiKey: 'K1' })).toBe('clear');
  expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer K1' });
  expect(await decisionsClassifier(transport as never)({ text: 'x', apiKey: undefined })).toBe('unavailable');
  expect(transport).toHaveBeenCalledOnce();
});

it('below the cap refuses on block and admits everything else with the fallback rule', async () => {
  const input = { text: 'x', apiKey: 'K' };
  await expect(judgePositioning({ classify: async () => 'block' }, input, false)).rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
  for (const verdict of ['allow', 'clear', 'unavailable'] as const)
    expect(await judgePositioning({ classify: async () => verdict }, input, false)).toBe(true);
  expect(await judgePositioning({ classify: async () => { throw new Error('x'); } }, input, false)).toBe(true);
});

it('at the cap admits only a clear verdict, without the rule, and refuses the rest (unavailable included)', async () => {
  const input = { text: 'x', apiKey: 'K' };
  expect(await judgePositioning({ classify: async () => 'clear' }, input, true)).toBe(false);
  for (const verdict of ['block', 'allow', 'unavailable'] as const)
    await expect(judgePositioning({ classify: async () => verdict }, input, true)).rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
  await expect(judgePositioning({ classify: async () => { throw new Error('x'); } }, input, true))
    .rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
});

it('asks the primary model to read the conversation, not only the current message', () => {
  expect(POSITIONING_FALLBACK_INSTRUCTIONS).toContain('read together with the conversation so far');
});

it('reads the 0233 gate state and fails operationally instead of guessing', async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: { positioned: true, refusals24h: 0 }, error: null })
    .mockResolvedValueOnce({ data: { positioned: false, refusals24h: 5 }, error: null })
    .mockResolvedValueOnce({ data: { positioned: false }, error: null })
    .mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
  const admin = { rpc } as unknown as SupabaseClient;
  expect(await readPositioningGate(admin, 'actor')).toEqual({ positioned: true, refusals24h: 0 });
  expect(await readPositioningGate(admin, 'actor')).toEqual({ positioned: false, refusals24h: 5 });
  await expect(readPositioningGate(admin, 'actor')).rejects.toBeInstanceOf(StagingAccessError);
  await expect(readPositioningGate(admin, 'actor')).rejects.toBeInstanceOf(StagingAccessError);
  expect(rpc).toHaveBeenCalledWith('runtime_positioning_gate', { p_actor_id: 'actor' });
});

it('maps the refusal to a stable code the front end can recognize', () => {
  const error = stagingProcedureError(new StagingAccessError('POSITIONING_REQUIRED'), 'runtime.prepare');
  expect(error.code).toBe('PRECONDITION_FAILED');
  expect(error.message.startsWith(POSITIONING_REQUIRED + '：')).toBe(true);
  expect(error.message).toContain('没有扣积分');
  expect(isPositioningRequired(error)).toBe(true);
  expect(isPositioningRequired({ state: 'cancelled', unavailable: 'positioning_required' } as never)).toBe(true);
  expect(isPositioningRequired({ message: 'RUNTIME_INPUT_TOO_LONG' })).toBe(false);
});

it('adds the fallback rule only to a turn frozen with it', () => {
  expect(withPrimaryAddenda('base', {})).toBe('base');
  expect(withPrimaryAddenda('base', { positioningGate: 'fallback-v1' })).toBe('base' + POSITIONING_FALLBACK_INSTRUCTIONS);
  expect(POSITIONING_FALLBACK_INSTRUCTIONS).toContain(POSITIONING_MARKER);
  expect(withPrimaryAddenda('base', { workspaceContext: true })).toContain('first read the confirmed entry whose kind is positioning');
});

it('recognizes only a reply that starts with the structured marker', () => {
  expect(isPositioningRefusal(POSITIONING_MARKER)).toBe(true);
  expect(isPositioningRefusal('\n ' + POSITIONING_MARKER)).toBe(true);
  expect(isPositioningRefusal('好的。' + POSITIONING_MARKER)).toBe(false);
  expect(isPositioningRefusal('[[GRAYLUM_POSITIONING')).toBe(false);
});

it('ends a refused PAYG round through fail_platform with positioning_required', async () => {
  const { endPositioningRefusal } = await import('./positioningFallback');
  const args = { p_execution_id: 'e' };
  const cancelled = vi.fn(async () => ({ state: 'cancelled' }));
  expect(await endPositioningRefusal(cancelled as never, args, true))
    .toEqual({ state: 'cancelled', unavailable: 'positioning_required', code: POSITIONING_REQUIRED });
  expect(cancelled).toHaveBeenCalledExactlyOnceWith('runtime_execution',
    { p_execution_id: 'e', p_action: 'fail_platform', p_result: { unavailable_reason: 'positioning_required' } });
  expect(await endPositioningRefusal(vi.fn(async () => ({ state: 'cost_pending' })) as never, args, true))
    .toEqual({ state: 'cost_pending' });
  // Unknown call outcome (round left open) or a lost response: interrupt for normal recovery, never claim "not charged".
  for (const outcome of [async () => ({ state: 'running' }), async () => { throw new Error('lost'); }]) {
    const rpc = vi.fn(async (_name: string, value: Record<string, unknown>) => value.p_action === 'interrupt' ? {} : outcome());
    expect(await endPositioningRefusal(rpc as never, args, true)).toEqual({ state: 'pending' });
    expect(rpc.mock.calls.map(call => call[1].p_action)).toEqual(['fail_platform', 'interrupt']);
  }
  const local = vi.fn(async () => ({ state: 'cancelled' }));
  expect(await endPositioningRefusal(local as never, args, false)).toEqual({ state: 'cancelled', code: POSITIONING_REQUIRED });
  expect(local).toHaveBeenCalledExactlyOnceWith('runtime_cancel', args);
});

it('uses only the credential the approved staging window quoted for this model', async () => {
  const { createHash } = await import('node:crypto');
  const account = (key: string) => 'openrouter-key:' + createHash('sha256').update(key).digest('hex');
  const row = { provider: 'openai', api_endpoint: '', api_key: 'APPROVED' };
  expect(windowBoundKey(row, account('APPROVED'))).toBe('APPROVED');
  expect(windowBoundKey({ ...row, api_key: 'ROTATED' }, account('APPROVED'))).toBeUndefined();
  expect(windowBoundKey(row, undefined)).toBeUndefined();
  expect(windowBoundKey({ ...row, api_endpoint: 'https://example.com/v1/chat/completions' }, account('APPROVED'))).toBeUndefined();
});
