/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { DEFAULT_STOP_LOSS, readStopLoss, saveStopLoss, stopLossConfigSchema, stopLossStatus, stopLossAlerts } from './stopLossSettings';
function fixture(value?: unknown) {
  const state = { value };
  const q = { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: state.value === undefined ? null : { value: state.value }, error: null }),
    upsert: vi.fn(async (row: { value: unknown }) => { state.value = row.value; return { error: null }; }) };
  return { db: { from: () => q } as never, q };
}
it('defaults monetary protection to disabled and reads saved exact decimal values', async () => {
  const f = fixture();
  expect(await readStopLoss(f.db)).toEqual({ config: DEFAULT_STOP_LOSS, source: 'default' });
  const config = { ...DEFAULT_STOP_LOSS, userDailyUsd: '0.000000000001', siteDailyUsd: '100.00' };
  expect(await saveStopLoss(f.db, config)).toEqual({ config, source: 'configured' });
});
it.each(['-1', '1e3', 'NaN', '01', '0.0000000000001', '', 10])('rejects invalid USD %s', value => {
  expect(stopLossConfigSchema.safeParse({ ...DEFAULT_STOP_LOSS, userDailyUsd: value }).success).toBe(false);
});
it('zero is an explicit zero budget and null disables a threshold', () => {
  expect(stopLossConfigSchema.parse({ ...DEFAULT_STOP_LOSS, siteDailyUsd: '0' }).siteDailyUsd).toBe('0');
});
it.each([{}, 'invalid json', { ...DEFAULT_STOP_LOSS, version: 2 }])('does not silently disable malformed config', async value => {
  await expect(readStopLoss(fixture(value).db)).rejects.toMatchObject({ message: 'RUNTIME_STOP_LOSS_UNAVAILABLE' });
});
it('hides internal errors from all read paths', async () => {
  const db = { from: () => { throw new Error('private'); } } as never;
  for (const call of [readStopLoss, stopLossStatus, stopLossAlerts]) {
    await expect(call(db)).rejects.toMatchObject({ message: 'RUNTIME_STOP_LOSS_UNAVAILABLE' });
  }
});
