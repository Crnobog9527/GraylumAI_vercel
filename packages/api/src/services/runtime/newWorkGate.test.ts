/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, expect, it, vi } from 'vitest';
import { newWorkGate, readNewWorkSettings, requireNewWork, requireLegacyCallsEnabled, denyNewCalls } from './newWorkGate';
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
    ['actor', 'admission', defaults, 'local', 1], ['actor', 'calls', defaults, 'local', 2],
  ]);
  await newWorkGate(db(), 'staging').message('other');
  expect(mock.redis).toHaveBeenLastCalledWith('other', 'admission', defaults, 'staging', 1);
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
  const result = await newWorkGate(db(), 'local').calls('actor', 31);
  expect(result).toEqual({ ok: false, reason: 'usage_configuration_required', retryAfter: 0, window: 'minute' });
  expect(() => requireNewWork(result)).toThrow('RUNTIME_USAGE_CONFIGURATION_REQUIRED');
});
