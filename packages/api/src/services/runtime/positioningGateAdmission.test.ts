/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runtimeAdmissionService } from './admission';
import { OPENING_INPUT } from '../../shared/opcQuestions';
import type { GateVerdict } from './positioningGate';
import { REPLY_LANGUAGE_INSTRUCTIONS } from './primaryInstructions';

// POSITIONING-GATE PR2: admission-side checks. A refusal happens before runtime_admit, so nothing is reserved or charged.
const mock = vi.hoisted(() => ({ redis: vi.fn(), recovery: vi.fn() }));
vi.mock('../redisRateLimiter', () => ({ checkRuntimeRateLimit: mock.redis }));
vi.mock('./automaticRecovery', () => ({ runAutomaticFinancialRecovery: mock.recovery }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture(options: { positioned?: boolean | 'error'; social?: boolean; refusals?: number } = {}) {
  let replay: { executionId: string } | null = null;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    if (name === 'runtime_session_context') return { data: { scope: { kind: 'positioning_draft', draftId: id(2) } }, error: null };
    if (name === 'runtime_admission_replay') return { data: replay, error: null };
    if (name === 'runtime_positioning_gate') return options.positioned === 'error'
      ? { data: null, error: { code: '57014', message: 'timeout' } }
      : { data: { positioned: options.positioned ?? false, refusals24h: options.refusals ?? 0 }, error: null };
    if (name === 'runtime_admit') return { data: { executionId: id(4), payload: args.p_payload }, error: null };
    throw new Error(name);
  });
  const model = { id: id(3), model_id: 'fixture', provider: 'fixture', is_active: 'true', max_tokens: 1000, input_limit: 32000 };
  const module = { id: id(7), active: true, skill_id: id(8), model_id: id(3), report_model_id: null, social_media_related: options.social ?? false };
  const from = vi.fn((table: string) => {
    const q = { select: () => q, eq: () => q, in: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: table === 'modules' ? module : model, error: null }) };
    return q;
  });
  const admin = { rpc, from } as unknown as SupabaseClient;
  const user = { auth: { getUser: async () => ({ data: { user: { id: id(1), email_confirmed_at: '2026-01-01' } }, error: null }) } };
  const classify = vi.fn(async (): Promise<GateVerdict> => 'allow');
  const policy = { account: 'local', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1',
    maxCalls: 3, maxOutputTokens: 1000, inputBytes: 32000, historyItems: 10, positioningGate: { classify } };
  const input = { sessionId: id(2), requestId: id(4), input: '帮我想下周小红书发什么', selection: { kind: 'ordinary', modelId: id(3) }, network: 'deny' };
  const names = () => rpc.mock.calls.map(([name]) => name);
  return { rpc, from, admin, user: user as unknown as SupabaseClient, policy, input, classify, names,
    replay: (value: { executionId: string }) => { replay = value; } };
}
beforeEach(() => {
  mock.redis.mockReset().mockResolvedValue({ success: true });
  mock.recovery.mockReset().mockResolvedValue({ failed: 0 });
});
const prepare = (f: ReturnType<typeof fixture>, policy: object = f.policy, input: object = f.input) =>
  runtimeAdmissionService(f.user, f.admin, policy as never).prepare(input);

it('never calls Decisions for a user with a confirmed positioning', async () => {
  const f = fixture({ positioned: true });
  const result = await prepare(f) as { payload: Record<string, unknown> };
  expect(f.classify).not.toHaveBeenCalled();
  expect(result.payload).not.toHaveProperty('positioningGate');
  expect(f.names()).toContain('runtime_admit');
});

it('admits an allowed message of a user without a positioning, judged exactly once', async () => {
  const f = fixture();
  const result = await prepare(f) as { payload: Record<string, unknown> };
  // The fixture model row has no OpenRouter key; the classifier gets the same row's key (none) without another read.
  expect(f.classify).toHaveBeenCalledExactlyOnceWith({ text: f.input.input, apiKey: undefined });
  // Decisions sees only this message: the primary model keeps the fallback rule for contextual requests.
  expect(result.payload.positioningGate).toBe('fallback-v1');
});

it('refuses a blocked message with the stable code before any execution or reservation', async () => {
  const f = fixture(); f.classify.mockResolvedValue('block');
  await expect(prepare(f)).rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
  expect(f.names()).not.toContain('runtime_admit');
});

it('admits with the frozen fallback rule when Decisions is unavailable or fails', async () => {
  for (const failure of [async (): Promise<GateVerdict> => 'unavailable', async (): Promise<GateVerdict> => { throw new Error('x'); }]) {
    const f = fixture(); f.classify.mockImplementation(failure);
    const result = await prepare(f) as { payload: Record<string, unknown> };
    expect(result.payload.positioningGate).toBe('fallback-v1');
  }
});

it('refuses a social media Skill outright without a Decisions call', async () => {
  const f = fixture({ social: true });
  await expect(prepare(f, f.policy, { ...f.input, selection: { kind: 'skill', moduleId: id(7), revisionId: id(9) } }))
    .rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
  expect(f.classify).not.toHaveBeenCalled();
  expect(f.names()).not.toContain('runtime_admit');
});

it('does not refuse a social media Skill for a user with a positioning', async () => {
  const f = fixture({ positioned: true, social: true });
  // Past the gate, the fixture has no Skill package, so the loader refuses with its own reason.
  await expect(prepare(f, f.policy, { ...f.input, selection: { kind: 'skill', moduleId: id(7), revisionId: id(9) } }))
    .rejects.not.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
});

it('fails operationally, never as "has none", when the positioning read fails', async () => {
  const f = fixture({ positioned: 'error' });
  await expect(prepare(f)).rejects.toMatchObject({ reason: 'RUNTIME_STAGING_SERVICE_UNAVAILABLE' });
  expect(f.classify).not.toHaveBeenCalled();
  expect(f.names()).not.toContain('runtime_admit');
});

it('never gates hosts without the policy, positioning (OPC) turns or a replay', async () => {
  const plain = fixture();
  await prepare(plain, { ...plain.policy, positioningGate: undefined });
  expect(plain.names()).not.toContain('runtime_positioning_gate');
  const opc = fixture(); opc.classify.mockResolvedValue('block');
  await prepare(opc, { ...opc.policy, mentorStream: true, opcTurnToken: id(5) }, { ...opc.input, input: OPENING_INPUT,
    selection: { kind: 'ordinary', modelId: id(3) } }).catch(() => undefined);
  expect(opc.names()).not.toContain('runtime_positioning_gate');
  expect(opc.classify).not.toHaveBeenCalled();
  const replayed = fixture(); replayed.classify.mockResolvedValue('block'); replayed.replay({ executionId: id(4) });
  expect(await prepare(replayed)).toEqual({ executionId: id(4) });
  expect(replayed.classify).not.toHaveBeenCalled();
});

it('judges each concurrent duplicate on its own and admits nothing when blocked', async () => {
  const f = fixture(); f.classify.mockResolvedValue('block');
  const results = await Promise.allSettled([prepare(f), prepare(f)]);
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  expect(f.names()).not.toContain('runtime_admit');
});

it('sizes the frozen fallback rule at admission, so a turn that fits never fails later in the executor', async () => {
  // Every non-mentor turn also carries the reply-language rule (SKILL-I18N-HOOK), sized the same way.
  const policyFor = (f: ReturnType<typeof fixture>) => ({ ...f.policy, inputBytes: 6000 + REPLY_LANGUAGE_INSTRUCTIONS.length });
  const admits = async (positioned: boolean, length: number) => {
    const f = fixture({ positioned });
    try { await prepare(f, policyFor(f), { ...f.input, input: 'x'.repeat(length) }); return true; }
    catch (error) { expect(error).toMatchObject({ reason: 'RUNTIME_INPUT_TOO_LONG' }); return false; }
  };
  // The longest message a positioned user (no rule) may send...
  let low = 1, high = 6000;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (await admits(true, mid)) low = mid; else high = mid - 1; }
  expect(await admits(true, low)).toBe(true);
  // ...is too long once the rule is part of the instructions, and is refused before any execution exists.
  expect(await admits(false, low)).toBe(false);
});

// Abuse guard (controller 2026-10-14): after 5 refunded fallback refusals in 24 hours.
describe('refund cap', () => {
  it('still admits ordinary chat (a clear verdict), normally charged and without the fallback rule', async () => {
    const f = fixture({ refusals: 5 }); f.classify.mockResolvedValue('clear');
    const result = await prepare(f, f.policy, { ...f.input, input: '推荐一下东京三日游的路线' }) as { payload: Record<string, unknown> };
    expect(result.payload).not.toHaveProperty('positioningGate');
    expect(f.names()).toContain('runtime_admit');
  });
  it.each(['allow', 'unavailable'] as const)('refuses an ambiguous request (%s) at admission, so no primary model call', async verdict => {
    const f = fixture({ refusals: 5 }); f.classify.mockResolvedValue(verdict);
    await expect(prepare(f, f.policy, { ...f.input, input: '好的，那帮我写三条' })).rejects.toMatchObject({ reason: 'POSITIONING_REQUIRED' });
    expect(f.names()).not.toContain('runtime_admit');
  });
  it('applies again only from the cap, and below it ambiguous requests keep the fallback rule', async () => {
    const f = fixture({ refusals: 4 }); f.classify.mockResolvedValue('allow');
    const result = await prepare(f) as { payload: Record<string, unknown> };
    expect(result.payload.positioningGate).toBe('fallback-v1');
  });
});
