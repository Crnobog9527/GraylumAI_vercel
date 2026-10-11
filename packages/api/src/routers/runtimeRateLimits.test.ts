/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { DEFAULT_STOP_LOSS } from '../services/runtime/stopLossSettings';
import {
  DEFAULT_RUNTIME_RATE_LIMITS as config, RUNTIME_RATE_LIMIT_KEY as key, readRuntimeRateLimits, saveRuntimeRateLimits,
} from '../services/runtime/rateLimitSettings';
import { runtimeSettingsHarness as harness } from './runtimeSettingsTestHarness';

it.each([false, true])('legacy pause preserves quotas when already stopped=%s', async stopped => {
  const f = harness('admin');
  const current = { ...config, callsPerMinute: 55, stopNewCalls: stopped };
  f.stored.set(key, current);
  // The old button sends a full, possibly stale config with the pause flag flipped to true.
  const result = await f.caller.update({ ...config, stopNewCalls: true });
  expect(result).toMatchObject({ source: 'configured', config: { ...current, stopNewCalls: true } });
  expect((await f.caller.get()).config).toEqual({ ...current, stopNewCalls: true });
  expect(f.writes).toEqual([{ name: 'runtime_set_stop_new_calls', args: { p_stopped: true } }]);
});
it.each([true, false])('legacy pause and stale quota save preserve both intents: pauseFirst=%s', async pauseFirst => {
  const f = harness('admin');
  const pause = () => f.caller.update({ ...config, stopNewCalls: true });
  const quota = () => f.caller.update({ ...config, callsPerMinute: 40 });
  if (pauseFirst) { await pause(); await quota(); }
  else { await quota(); await pause(); }
  expect((await f.caller.get()).config).toEqual({ ...config, callsPerMinute: 40, stopNewCalls: true });
});
it('legacy pause fails visibly if the atomic stop write fails', async () => {
  const rpc = vi.fn(async () => ({ error: { code: 'XX000' }, data: null }));
  await expect(saveRuntimeRateLimits({ rpc } as never, { ...config, stopNewCalls: true }))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('runtime_set_stop_new_calls', { p_stopped: true });
});
it.each(['user', 'anonymous'] as const)('denies %s both read and write', async role => {
  const f = harness(role);
  for (const call of [() => f.caller.get(), () => f.caller.update(config)])
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  expect(f.writes).toEqual([]);
});
it.each([
  { ...config, admissionPerMinute: 0 }, { ...config, admissionPerMinute: 61 },
  { ...config, admissionPerMinute: 1.5 }, { ...config, admissionPer24Hours: 5001 },
  { ...config, admissionPer24Hours: 9 }, { ...config, callsPerMinute: 181 },
  { ...config, callsPer24Hours: 15001 }, { ...config, callsPer24Hours: 29 },
  { ...config, version: 2 }, { ...config, stopNewCalls: 'false' },
  { ...config, extra: true }, { ...config, callsPerMinute: -1 },
])('rejects invalid config before writes %#', async invalid => {
  const f = harness('admin');
  await expect(f.caller.update(invalid as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
it('blocks generic single/bulk writes', async () => {
  const f = harness('admin');
  await expect(f.generic.updateSystemSettings({ key, value: config })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(f.generic.updateSystemSettingsBulk([{ key, value: config }])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
it.each(['not-json', 'null', '{}', JSON.stringify({ ...config, version: 2 })])(
  'rejects malformed stored config instead of defaults: %s', async value => {
    const f = harness('admin'); f.stored.set(key, value);
    await expect(f.caller.get()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
it('does not cache configuration or hide a database read failure', async () => {
  const f = harness('admin');
  expect((await f.caller.get()).config.stopNewCalls).toBe(false);
  f.stored.set(key, { ...config, stopNewCalls: true });
  expect((await f.caller.get()).config.stopNewCalls).toBe(true);
  const db = { from: vi.fn(() => { throw new Error('synthetic private database error'); }) };
  await expect(readRuntimeRateLimits(db as never)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存使用额度，请稍后再试',
  });
});

it.each([{ code: 'XX000' }, null])('fails closed on an RPC error or invalid result', async error => {
  const rpc = vi.fn(async () => ({ error, data: null }));
  await expect(saveRuntimeRateLimits({ rpc } as never, config))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存使用额度，请稍后再试' });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it.each(['user', 'anonymous'] as const)('denies %s all stop-loss administration', async role => {
  const f = harness(role);
  for (const call of [() => f.caller.stopLossConfig(), () => f.caller.updateStopLoss({ config: DEFAULT_STOP_LOSS, expectedVersion: 0 }),
    () => f.caller.setStopNewCalls({ stopped: true }), () => f.caller.stopLossStatus(), () => f.caller.stopLossAlerts(),
    () => f.caller.recordProviderBalance({ provider: 'openrouter', balanceUsd: '0' })]) {
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  }
  expect(f.writes).toEqual([]);
});
it('admin manages stop-loss config but generic settings cannot bypass validation', async () => {
  const f = harness('admin');
  expect((await f.caller.updateStopLoss({ config: { ...DEFAULT_STOP_LOSS, siteDailyUsd: '1.25' }, expectedVersion: 0 })).config.siteDailyUsd).toBe('1.25');
  await expect(f.generic.updateSystemSettings({ key: 'runtime_stop_loss', value: {} })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('switch and legacy quota edits preserve each other in either order', async () => {
  const f = harness('admin');
  await f.caller.setStopNewCalls({ stopped: true });
  expect((await f.caller.update({ ...config, callsPerMinute: 40 })).config)
    .toEqual({ ...config, callsPerMinute: 40, stopNewCalls: true });
  expect((await f.caller.setStopNewCalls({ stopped: false })).config)
    .toEqual({ ...config, callsPerMinute: 40 });
  expect(f.writes).toEqual([
    { name: 'runtime_set_stop_new_calls', args: { p_stopped: true } },
    { name: 'runtime_update_rate_limits', args: { p_limits: {
      admissionPerMinute: 10, admissionPer24Hours: 200, callsPerMinute: 40, callsPer24Hours: 600,
    } } },
    { name: 'runtime_set_stop_new_calls', args: { p_stopped: false } },
  ]);
});
it('requires a version and reports a stale stop-loss editor as HTTP 409', async () => {
  const { getHTTPStatusCodeFromError } = await import('@trpc/server/http');
  const f = harness('admin');
  const initial = await f.caller.stopLossConfig();
  expect(initial.revision).toBe(0);
  const first = await f.caller.updateStopLoss({ config: { ...initial.config, siteDailyUsd: '3' }, expectedVersion: 0 });
  expect(first.revision).toBe(1);
  try {
    await f.caller.updateStopLoss({ config: { ...initial.config, siteDailyUsd: '4' }, expectedVersion: 0 });
    throw new Error('must conflict');
  } catch (error) {
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(getHTTPStatusCodeFromError(error as never)).toBe(409);
  }
  expect((await f.caller.stopLossConfig()).config.siteDailyUsd).toBe('3');
  await expect(f.caller.updateStopLoss(initial.config as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
it('rejects extra switch fields rather than accepting a quota patch', async () => {
  const f = harness('admin');
  await expect(f.caller.setStopNewCalls({ stopped: true, callsPerMinute: 2 } as never))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
