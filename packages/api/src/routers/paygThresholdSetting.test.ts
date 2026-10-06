/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { settingsRouter } from './settings';
import { paygStartThresholdsSchema } from '../services/adminSettings';
import { PAYG_START_THRESHOLDS_KEY } from '../services/bill2/settingKeys';

const threshold = { model: 'fixture/model', purpose: 'skill', typicalUsd: '0.04415' };
const valid = { version: 'p50-v1', thresholds: [threshold] };
const invalid = [null, JSON.stringify(valid), {}, { ...valid, version: 1 }, { ...valid, version: ' ' },
  { ...valid, thresholds: [] }, { ...valid, thresholds: [threshold, threshold] },
  ...[null, 0.04415, '', '-1', '1e-3', 'NaN', '01', '0.0000000000001', '1000000000000']
    .map(typicalUsd => ({ ...valid, thresholds: [{ ...threshold, typicalUsd }] })),
  { ...valid, thresholds: [{ ...threshold, credits: 14 }] },
  { ...valid, thresholds: [{ ...threshold, typicalUsd: null, credits: 14 }] },
];

it('accepts exact USD strings and legacy integer entries; rejects ambiguous/invalid formats', () => {
  for (const typicalUsd of ['0', '0.00028', '0.01274', '0.04415', '0.010000000001']) {
    expect(paygStartThresholdsSchema.safeParse({ ...valid, thresholds: [{ ...threshold, typicalUsd }] }).success).toBe(true);
  }
  for (const credits of [1, 4, 14, '14', 999999999]) {
    expect(paygStartThresholdsSchema.safeParse({ ...valid, thresholds: [
      { model: threshold.model, purpose: threshold.purpose, credits },
    ] }).success).toBe(true);
  }
  expect(paygStartThresholdsSchema.safeParse({ ...valid, thresholds: [threshold,
    { ...threshold, purpose: 'organizer' }, { ...threshold, model: 'fixture/second' },
  ] }).success).toBe(true);
  for (const value of invalid) expect(paygStartThresholdsSchema.safeParse(value).success).toBe(false);
});

function setup(role = 'admin') {
  const profile = { id: 'test-admin', role, status: 'active', is_deleted: 'false', nickname: 'Test' };
  const upsert = vi.fn(() => ({ select: async () => ({ data: [], error: null }) }));
  const client = { from: () => ({ select() { return this; }, eq() { return this; },
    single: async () => ({ data: profile, error: null }), upsert }) };
  const caller = settingsRouter.createCaller({ headers: new Headers(), user: { id: profile.id,
    app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } }, isEmailVerified: true,
    authProvider: 'email', hasSupabaseAdminPrivileges: true, supabase: client, supabasePublic: {}, supabaseAdmin: client,
  } as unknown as Parameters<typeof settingsRouter.createCaller>[0]);
  return { caller, upsert };
}

it.each([false, true])('validates actual settings writes before persisting (bulk=%s)', async bulk => {
  const { caller, upsert } = setup();
  const write = (value: unknown) => bulk
    ? caller.updateSystemSettingsBulk([{ key: PAYG_START_THRESHOLDS_KEY, value }])
    : caller.updateSystemSettings({ key: PAYG_START_THRESHOLDS_KEY, value });
  for (const value of invalid) await expect(write(value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(upsert).not.toHaveBeenCalled();
  await write(valid);
  expect(upsert).toHaveBeenCalledOnce();
  const record = { key: PAYG_START_THRESHOLDS_KEY, value: valid };
  expect(upsert).toHaveBeenCalledWith(bulk ? [record] : record, { onConflict: 'key' });
});

it('does not grant non-admin access to threshold writes', async () => {
  const { caller, upsert } = setup('user');
  await expect(caller.updateSystemSettings({ key: PAYG_START_THRESHOLDS_KEY, value: valid }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(upsert).not.toHaveBeenCalled();
});
