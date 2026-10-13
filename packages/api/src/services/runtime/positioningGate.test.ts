/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { DECISIONS_MODEL, DECISIONS_URL, decide, decisionsClassifier, hasConfirmedPositioning, judgePositioning } from './positioningGate';
import { holdsPositioningMarker, isPositioningRefusal, POSITIONING_MARKER, POSITIONING_FALLBACK_INSTRUCTIONS } from './positioningFallback';
import { withPrimaryAddenda } from './primaryInstructions';
import { stagingProcedureError, StagingAccessError } from './stagingErrors';
import { isPositioningRequired, POSITIONING_REQUIRED } from '../../shared/positioningGate';

afterEach(() => vi.restoreAllMocks());
const answer = (noul: number, cost = 0.00002) => new Response(JSON.stringify({
  answers: { own_account_social_media_operations: { type: 'noul', noul } }, model: DECISIONS_MODEL,
  usage: { input_tokens: 300, output_tokens: 1, cost } }), { status: 200 });

it.each([[0.91, 'block'], [0.5, 'block'], [0.12, 'allow']] as const)('Decisions probability %s means %s', async (noul, verdict) => {
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

it.each([
  ['an HTTP error', async () => new Response('{"error":{"message":"secret"}}', { status: 503 })],
  ['a transport failure', async () => { throw new Error('network'); }],
  ['a timeout', async () => { throw new DOMException('timeout', 'TimeoutError'); }],
  ['a malformed answer', async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })],
  ['an out-of-range probability', async () => answer(3)],
])('treats %s as unavailable', async (_name, transport) => {
  expect(await decide('KEY', 'x', vi.fn(transport) as never)).toBe('unavailable');
});

function models(row: Record<string, unknown> | null) {
  const q = { select: () => q, eq: () => q, single: async () => row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } } };
  return { from: vi.fn(() => q) } as unknown as SupabaseClient;
}
it('reuses the admitted model row OpenRouter key and never calls without one', async () => {
  const transport = vi.fn(async () => answer(0.1));
  expect(await decisionsClassifier(models({ provider: 'openai', api_endpoint: '', api_key: ' K1 ' }), transport as never)
    ({ text: 'x', modelRowId: 'm' })).toBe('allow');
  expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer K1' });
  for (const row of [null, { provider: 'fixture', api_endpoint: null, api_key: 'K' },
    { provider: 'openai', api_endpoint: 'https://example.com/v1/chat/completions', api_key: 'K' },
    { provider: 'openai', api_endpoint: '', api_key: ' ' }]) {
    expect(await decisionsClassifier(models(row), transport as never)({ text: 'x', modelRowId: 'm' })).toBe('unavailable');
  }
  expect(transport).toHaveBeenCalledOnce();
});

it('refuses on block, falls back on unavailable or a thrown classifier, and passes on allow', async () => {
  const admin = models(null), input = { text: 'x', modelRowId: 'm' };
  await expect(judgePositioning({ classify: async () => 'block' }, admin, input)).rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
  expect(await judgePositioning({ classify: async () => 'unavailable' }, admin, input)).toBe(true);
  expect(await judgePositioning({ classify: async () => { throw new Error('x'); } }, admin, input)).toBe(true);
  expect(await judgePositioning({ classify: async () => 'allow' }, admin, input)).toBe(false);
});

it('reads the 0219 rule and fails operationally instead of guessing', async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null })
    .mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
  const admin = { rpc } as unknown as SupabaseClient;
  expect(await hasConfirmedPositioning(admin, 'actor')).toBe(true);
  expect(await hasConfirmedPositioning(admin, 'actor')).toBe(false);
  await expect(hasConfirmedPositioning(admin, 'actor')).rejects.toBeInstanceOf(StagingAccessError);
  expect(rpc).toHaveBeenCalledWith('opc_has_confirmed_positioning', { p_actor_id: 'actor' });
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

it('recognizes the structured marker and holds back only text that could still become it', () => {
  expect(isPositioningRefusal(POSITIONING_MARKER)).toBe(true);
  expect(isPositioningRefusal('\n ' + POSITIONING_MARKER)).toBe(true);
  expect(isPositioningRefusal('好的。' + POSITIONING_MARKER)).toBe(false);
  for (const visible of ['', ' ', '[', '[[GRAY', POSITIONING_MARKER, POSITIONING_MARKER + '\n']) expect(holdsPositioningMarker(visible)).toBe(true);
  for (const visible of ['好', '[链接]', '[[其他]]']) expect(holdsPositioningMarker(visible)).toBe(false);
});
