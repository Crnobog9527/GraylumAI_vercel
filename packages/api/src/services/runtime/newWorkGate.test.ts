/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newWorkGate, readAdmissionSettings, readNewWorkSettings, requireNewWork, requireLegacyCallsEnabled, denyNewCalls } from './newWorkGate';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from './rateLimitSettings';
import { runtimeGateMessages } from '../../shared/runtimeGateMessages';
import { RateLimitError } from '../../lib/rateLimitError';
const mock = vi.hoisted(() => ({ redis: vi.fn(), log: vi.fn() }));
vi.mock('../redisRateLimiter', () => ({ checkRuntimeRateLimit: mock.redis }));
vi.mock('../../lib/logger', () => ({ logger: { info: mock.log, error: mock.log } }));
function db(value: unknown = defaults, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: value === null ? null : { value }, error });
  const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle };
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}
beforeEach(() => { vi.clearAllMocks(); mock.redis.mockResolvedValue({ success: true }); });
it('uses defaults for a missing row and the same identity across hosts and messages', async () => {
  const gate = newWorkGate(db(null), 'local');
  expect(await gate.message('actor')).toEqual({ ok: true });
  expect(await gate.calls('actor', 2)).toEqual({ ok: true });
  expect(mock.redis.mock.calls).toEqual([
    ['actor', 'admission', defaults, 'local', 1, 'bill2.v1', true], ['actor', 'calls', defaults, 'local', 2, 'bill2.v1', true],
  ]);
  await newWorkGate(db(), 'staging').message('other');
  expect(mock.redis).toHaveBeenLastCalledWith('other', 'admission', defaults, 'staging', 1, 'bill2.v1', true);
});
it('checks a resumed claim against current limits without reserving it twice', async () => {
  const result = await newWorkGate(db(), 'staging').calls('actor', 1, 'bill2.v2', false);
  expect(result).toEqual({ ok: true });
  expect(mock.redis).toHaveBeenCalledExactlyOnceWith('actor', 'calls', defaults, 'staging', 1, 'bill2.v2', false);
});
it('reads each request, pauses before Redis, and covers legacy entry points', async () => {
  const database = db({ ...defaults, stopNewCalls: true });
  const gate = newWorkGate(database, 'local');
  expect(await gate.message('actor')).toMatchObject({ reason: 'paused' });
  expect(await gate.calls('actor', 2)).toMatchObject({ reason: 'paused' });
  await expect(requireLegacyCallsEnabled(database)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE', message: runtimeGateMessages.paused, retryAfter: 60,
  });
  expect(database.from).toHaveBeenCalledTimes(3);
  expect(mock.redis).not.toHaveBeenCalled();
});
it.each(['invalid', 'error'])('fails closed for %s settings and handles speculative read rejection', async mode => {
  const database = mode === 'invalid' ? db({}) : db(null, { message: 'private' });
  const read = readNewWorkSettings(database);
  expect(await newWorkGate(database, 'local').message('actor', read)).toMatchObject({ reason: 'limit_unavailable' });
  expect(mock.redis).not.toHaveBeenCalled();
  expect(await read).toEqual({ ok: false });
});
it.each(['minute', 'day'] as const)('preserves %s rejection, safe message and retry hint', async window => {
  mock.redis.mockResolvedValue({ success: false, reason: 'rate_limited', window, retryAfter: 25 });
  const result = await newWorkGate(db(), 'local').message('actor');
  expect(result).toEqual({ ok: false, reason: 'call_limited', window, retryAfter: 25 });
  expect(() => requireNewWork(result)).toThrowError(expect.objectContaining({
    code: 'TOO_MANY_REQUESTS', message: runtimeGateMessages[window], retryAfter: 25,
  }));
});
it('recovery-only gate always denies and preserves old RateLimitError defaults', async () => {
  expect(() => requireNewWork({ ok: true })).not.toThrow();
  const result = await denyNewCalls('actor', 2);
  expect(() => requireNewWork(result)).toThrowError(expect.objectContaining({
    code: 'SERVICE_UNAVAILABLE', message: runtimeGateMessages.limit_unavailable,
  }));
  expect(mock.redis).not.toHaveBeenCalled();
  expect(new RateLimitError('unavailable').message).toBe('服务暂时繁忙，请稍后再试');
  expect(new RateLimitError('rate_limited', 10).message).toBe('请求过于频繁，请在 10 秒后重试');
});
it('exposes a distinct configuration diagnostic without a retry-later hint', async () => {
  mock.redis.mockResolvedValue({ success: false, reason: 'usage_configuration_required', retryAfter: 0, window: 'minute' });
  const result = await newWorkGate(db(), 'local').calls('actor', 31, 'bill2.v2');
  expect(mock.redis).toHaveBeenLastCalledWith('actor', 'calls', defaults, 'local', 31, 'bill2.v2', true);
  expect(result).toEqual({ ok: false, reason: 'usage_configuration_required', retryAfter: 0, window: 'minute' });
  expect(() => requireNewWork(result)).toThrow('RUNTIME_USAGE_CONFIGURATION_REQUIRED');
});

it.each([undefined, 'bill2.v1'] as const)('keeps the existing public notice for %s oversized v1 rounds', async version => {
  mock.redis.mockResolvedValue({ success: false, reason: 'unavailable', retryAfter: 60 });
  const result = await newWorkGate(db(), 'local').calls('actor', 31, version);
  expect(mock.redis).toHaveBeenLastCalledWith('actor', 'calls', defaults, 'local', 31, 'bill2.v1', true);
  expect(result).toMatchObject({ ok: false, reason: 'limit_unavailable', retryAfter: 60 });
  expect(() => requireNewWork(result)).toThrowError(expect.objectContaining({
    code: 'SERVICE_UNAVAILABLE', message: runtimeGateMessages.limit_unavailable,
  }));
});

describe('MODEL-IDENTITY-GUARD switch rides on the admission settings read', () => {
  const db = (rows: Array<{ key: string; value: unknown }>) => {
    const keys: string[][] = [];
    return { keys, client: { from: () => ({ select: () => ({ in: async (_c: string, k: string[]) => {
      keys.push(k); return { data: rows, error: null };
    } }) }) } as never };
  };
  it.each([
    ['absent', [], true],
    ['on', [{ key: 'model_identity_guard', value: { version: 1, enabled: true, revision: 1, updatedBy: null, updatedAt: null } }], true],
    ['off', [{ key: 'model_identity_guard', value: { version: 1, enabled: false, revision: 2, updatedBy: null, updatedAt: null } }], false],
    ['malformed', [{ key: 'model_identity_guard', value: 'nope' }], true],
  ] as const)('%s', async (_name, rows, expected) => {
    const f = db([...rows]);
    const read = await readAdmissionSettings(f.client);
    expect(read).toMatchObject({ ok: true, config: defaults, identityGuard: expected });
    expect(f.keys).toEqual([['runtime_rate_limits', 'model_identity_guard', 'primary_model_id', 'research_tools_config']]);
  });
  // UI-MODEL: the administrator's primary model rides on the same read; only a uuid counts as configured.
  it.each([
    ['set', [{ key: 'primary_model_id', value: '10000000-0000-4000-8000-000000000003' }], '10000000-0000-4000-8000-000000000003'],
    ['absent', [], undefined],
    ['cleared', [{ key: 'primary_model_id', value: '' }], undefined],
    ['model name', [{ key: 'primary_model_id', value: 'anthropic/claude' }], undefined],
  ] as const)('primary model %s', async (_name, rows, expected) => {
    const read = await readAdmissionSettings(db([...rows]).client);
    expect(read.ok && read.primaryModelId).toBe(expected ?? undefined);
  });
  // RT-6: the research master switch rides on the same read; only a valid stored config that is on counts.
  it('research switch on the same read', async () => {
    const { DISABLED_RESEARCH_TOOLS } = await import('../research/vendors/config');
    const stored = (enabled: boolean) => ({ ...DISABLED_RESEARCH_TOOLS, enabled, revision: 3,
      updatedBy: '10000000-0000-4000-8000-000000000001', updatedAt: '2026-10-17T00:00:00.000Z' });
    for (const [value, expected] of [[stored(true), true], [JSON.stringify(stored(true)), true], [stored(false), false]] as const) {
      const read = await readAdmissionSettings(db([{ key: 'research_tools_config', value }]).client);
      expect(read.ok && read.researchEnabled).toBe(expected);
    }
    for (const value of [undefined, 'not json', { enabled: true }]) {
      const read = await readAdmissionSettings(db(value === undefined ? [] : [{ key: 'research_tools_config', value }]).client);
      expect(read.ok && read.researchEnabled).toBe(false);
    }
  });
  it('malformed rate limits still fail closed', async () => {
    expect(await readAdmissionSettings(db([{ key: 'runtime_rate_limits', value: { version: 2 } }]).client)).toEqual({ ok: false });
  });
});
