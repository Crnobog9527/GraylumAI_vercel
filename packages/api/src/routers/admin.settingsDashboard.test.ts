/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { REPORT_SETTING } from '../services/report/contract';
import { adminRouter } from './admin';
import { settingsRouter } from './settings';
import { PAYMENT_CHANNEL_KEY } from '../services/payments/channelSettings';
import { PAYG_HOST_SETTING } from '../services/runtime/paygHostPolicy';
import { RUNTIME_RATE_LIMIT_KEY } from '../services/runtime/rateLimitSettings';
import { PURPOSE_BUDGET_KEY } from '../services/runtime/purposeBudgets';
import { PROVIDER_PRICES_KEY } from '../services/billingProviderPrices';
import { ABSORB_CONFIG_KEY, ABSORB_ACK_KEY } from '../services/bill2PlatformAlerts';

const structuredSettings = [
  { key: PAYMENT_CHANNEL_KEY, value: { channel: 'stripe', version: 3 } },
  { key: PAYG_HOST_SETTING, value: { enabled: false } },
  { key: REPORT_SETTING, value: { enabled: false } },
  { key: RUNTIME_RATE_LIMIT_KEY, value: { stopNewCalls: true } },
  { key: PURPOSE_BUDGET_KEY, value: { version: 2, purposes: {} } },
  { key: PROVIDER_PRICES_KEY, value: { version: 1, entries: [] } },
  { key: ABSORB_CONFIG_KEY, value: { defaultUsd: '0', models: {} } },
  { key: ABSORB_ACK_KEY, value: {} },
];

type Row = { key: string; value: unknown };
function fixture(initial: Row[]) {
  const stored = new Map(initial.map(row => [row.key, structuredClone(row.value)]));
  const profile = { id: 'fixture-admin', role: 'admin', status: 'active', nickname: 'Fixture', is_deleted: 'false' };
  const upsert = vi.fn((rows: Row[], options: unknown) => {
    expect(options).toEqual({ onConflict: 'key' });
    for (const row of rows) stored.set(row.key, row.value);
    return { select: async () => ({ data: rows, error: null }) };
  });
  const client = {
    from(table: string) {
      if (table === 'profiles') return {
        select() { return this; }, eq() { return this; },
        single: async () => ({ data: profile, error: null }),
      };
      if (table === 'system_settings') return {
        select: async () => ({ data: Array.from(stored, ([key, value]) => ({ key, value })), error: null }),
        upsert,
      };
      if (table === 'membership_plans') return {
        select() { return this; }, order: async () => ({ data: [], error: null }),
      };
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const ctx = {
    headers: new Headers(), user: { id: profile.id }, isEmailVerified: true,
    authProvider: 'email', hasSupabaseAdminPrivileges: true,
    supabase: client, supabaseAdmin: client, supabasePublic: client,
  } as unknown as Parameters<typeof adminRouter.createCaller>[0];
  return { admin: adminRouter.createCaller(ctx), settings: settingsRouter.createCaller(ctx), stored, upsert };
}

describe('settings dashboard structured settings isolation', () => {
  it.each(structuredSettings)('excludes $key before scalar validation', async (row) => {
    const { admin } = fixture([row, { key: 'site_name', value: 'Fixture site' }]);
    await expect(admin.getSettingsDashboard()).resolves.toEqual({
      systemSettings: { site_name: 'Fixture site' }, membershipPlans: [],
    });
  });

  it('reads all structured settings together and bulk-saves only submitted scalar keys', async () => {
    const { admin, settings, stored, upsert } = fixture([
      ...structuredSettings,
      { key: 'site_name', value: 'Fixture site' },
      { key: 'maintenance_mode', value: false },
      { key: 'max_input_characters', value: 10000 },
    ]);
    const before = await admin.getSettingsDashboard();
    expect(before.systemSettings).toEqual({
      site_name: 'Fixture site', maintenance_mode: false, max_input_characters: 10000,
    });
    const changes = [{ key: 'site_name', value: 'Updated fixture' }];
    await settings.updateSystemSettingsBulk(changes);
    expect(upsert).toHaveBeenCalledExactlyOnceWith(changes, { onConflict: 'key' });
    for (const row of structuredSettings) expect(stored.get(row.key)).toEqual(row.value);
    await expect(admin.getSettingsDashboard()).resolves.toEqual({
      ...before, systemSettings: { ...before.systemSettings, site_name: 'Updated fixture' },
    });
  });

  it('does not validate dedicated values even when they are malformed or serialized', async () => {
    const { admin } = fixture(structuredSettings.map(row => ({ ...row, value: 'invalid dedicated value' })));
    await expect(admin.getSettingsDashboard()).resolves.toEqual({ systemSettings: {}, membershipPlans: [] });
  });
});
