/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { DEFAULT_STOP_LOSS, readStopLoss, saveStopLoss, stopLossConfigSchema, stopLossStatus, stopLossAlerts } from './stopLossSettings';
function fixture(value?: unknown) {
  const state = { value };
  const q = { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: state.value === undefined ? null : { value: state.value }, error: null }),
 };
  return { db: { from: () => q, rpc: async (_name: string, args: { p_config: object }) => {
    state.value = { ...args.p_config, revision: 1 }; return { data: state.value, error: null };
  } } as never, q };
}
it('defaults monetary protection to disabled and reads saved exact decimal values', async () => {
  const f = fixture();
  expect(await readStopLoss(f.db)).toEqual({ config: DEFAULT_STOP_LOSS, revision: 0, source: 'default' });
  const config = { ...DEFAULT_STOP_LOSS, userDailyUsd: '0.000000000001', siteDailyUsd: '100.00' };
  expect(await saveStopLoss(f.db, { config, expectedVersion: 0 })).toEqual({ config, revision: 1, source: 'configured' });
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

it('counts channel labels by Unicode code points like PostgreSQL after trimming', () => {
  for (const notificationChannel of ['a'.repeat(100), '😀'.repeat(100), ' a ' + ' '.repeat(100)]) {
    expect(stopLossConfigSchema.parse({ ...DEFAULT_STOP_LOSS, notificationChannel }).notificationChannel)
      .toBe(notificationChannel.trim());
  }
  for (const notificationChannel of ['', '   ', 'a'.repeat(101), '😀'.repeat(101), '\uFEFF']) {
    expect(stopLossConfigSchema.safeParse({ ...DEFAULT_STOP_LOSS, notificationChannel }).success).toBe(false);
  }
});

it('reads historical JSON string values as revision zero', async () => {
  expect(await readStopLoss(fixture(JSON.stringify(DEFAULT_STOP_LOSS)).db))
    .toMatchObject({ config: DEFAULT_STOP_LOSS, revision: 0 });
});
it.each([-1, null, '1', 1.5, 10000000000])('fails closed on invalid stored revision %s', async revision => {
  await expect(readStopLoss(fixture({ ...DEFAULT_STOP_LOSS, revision }).db))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
});
it('does not translate conflicts into unavailable errors', async () => {
  const db = { rpc: async () => ({ data: null, error: { code: 'PT409', message: 'private detail' } }) } as never;
  await expect(saveStopLoss(db, { config: DEFAULT_STOP_LOSS, expectedVersion: 1 }))
    .rejects.toMatchObject({ code: 'CONFLICT', message: '设置已被其他人修改，请重新读取后再保存' });
});
