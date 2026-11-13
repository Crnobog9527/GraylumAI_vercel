/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { REPORT_SETTING } from '../services/report/contract';
import { PAYG_START_THRESHOLDS_KEY } from '../services/turn/settings/settingKeys';
import { logger } from '../lib/logger';
import { adminRouter } from './admin';
import { settingsRouter } from './settings';
import { PAYMENT_CHANNEL_KEY } from '../services/payments/channelSettings';
import { PAYG_HOST_SETTING } from '../services/turn/admission/paygHostPolicy';
import { RUNTIME_RATE_LIMIT_KEY } from '../services/turn/settings/rateLimitSettings';
import { PURPOSE_BUDGET_KEY } from '../services/turn/settings/purposeBudgets';
import { PROVIDER_PRICES_KEY } from '../services/billingProviderPrices';
import { ABSORB_CONFIG_KEY, ABSORB_ACK_KEY } from '../services/bill2PlatformAlerts';

const structuredSettings = [
  { key: PAYG_START_THRESHOLDS_KEY, value: { version: 'fixture', thresholds: [] } },
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

  it('reads the staging key set with payment structures and retired keys (LEGACY-CLOSE 500)', async () => {
    const retired = ['assistant_model_id', 'chat_billing_hint', 'chat_prompt_text', 'chat_show_model_selector',
      'chat_welcome_message', 'enable_free_tier', 'enable_long_text_warning', 'enable_prompt_cache',
      'enable_smart_routing', 'enable_smart_search_decision', 'free_tier_messages', 'input_credits_per_1k',
      'long_text_warning_threshold', 'max_messages_per_conversation', 'output_credits_per_1k',
      'search_decision_min_confidence', 'show_token_usage_stats', 'smart_routing_min_confidence', 'web_search_credits'];
    const kept = { primary_model_id: 'd04a4800-2d3a-43b3-8af9-cb960572e34f', v3_summary_max_tokens: '4096',
      search_surcharge_credits: '15', home_show_onboarding: 'true', max_input_characters: '10000',
      billing_credits_per_usd: '100', library_upload_enabled: false, fusion_compare_max_models: 4 };
    const { admin } = fixture([
      ...structuredSettings,
      { key: 'payment_method_routes', value: { version: 3, card: { enabled: false },
        wechat_pay: { enabled: true, annualVerified: false }, alipay: { enabled: true, annualVerified: false } } },
      { key: 'payment_terms_version', value: { version: 'fixture-terms' } },
      ...retired.map(key => ({ key, value: 'true' })),
      ...Object.entries(kept).map(([key, value]) => ({ key, value })),
    ]);
    const { systemSettings } = await admin.getSettingsDashboard();
    expect(systemSettings).toMatchObject(kept);
    expect(systemSettings).not.toHaveProperty('payment_method_routes');
    expect(systemSettings).not.toHaveProperty('payment_terms_version');
  });

  it('skips unknown structured values with a warning instead of failing the page', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { admin } = fixture([
        { key: 'future_structured_setting', value: { version: 1, enabled: true } },
        { key: 'future_list_setting', value: ['a'] },
        { key: 'site_name', value: 'Fixture site' },
      ]);
      await expect(admin.getSettingsDashboard()).resolves.toEqual({
        systemSettings: { site_name: 'Fixture site' }, membershipPlans: [],
      });
      expect(warn).toHaveBeenCalledWith('api', 'admin_settings_unknown_structured_key_skipped', { key: 'future_structured_setting' });
      expect(warn).toHaveBeenCalledWith('api', 'admin_settings_unknown_structured_key_skipped', { key: 'future_list_setting' });
    } finally {
      warn.mockRestore();
    }
  });

  it('does not validate dedicated values even when they are malformed or serialized', async () => {
    const { admin } = fixture(structuredSettings.map(row => ({ ...row, value: 'invalid dedicated value' })));
    await expect(admin.getSettingsDashboard()).resolves.toEqual({ systemSettings: {}, membershipPlans: [] });
  });
});

// BOT-GUARD: the opening grant's cap and pause are ordinary settings with strict values; today's count is its own read.
describe('signup gift settings', () => {
  it('saves a whole-number cap 0-100000 and a true/false pause, and refuses anything else (an empty box is not 0)', async () => {
    const { settings, stored } = fixture([]);
    for (const value of ['30', 0, '100000', ' 45 ']) await settings.updateSystemSettingsBulk([{ key: 'signup_gift_daily_cap', value }]);
    for (const value of [true, 'false']) await settings.updateSystemSettingsBulk([{ key: 'signup_gift_paused', value }]);
    expect([stored.get('signup_gift_daily_cap'), stored.get('signup_gift_paused')]).toEqual([' 45 ', 'false']);
    for (const value of ['', '  ', '-1', '100001', '2.5', 'abc', null, 1.5]) {
      await expect(settings.updateSystemSettings({ key: 'signup_gift_daily_cap', value }), String(value)).rejects.toThrow();
      await expect(settings.updateSystemSettingsBulk([{ key: 'signup_gift_daily_cap', value }]), String(value)).rejects.toThrow();
    }
    for (const value of ['yes', 1, null, '']) {
      await expect(settings.updateSystemSettings({ key: 'signup_gift_paused', value }), String(value)).rejects.toThrow();
    }
    expect(stored.get('signup_gift_daily_cap')).toBe(' 45 ');
  });

  it("reads today's count through the service-role function and refuses an unexpected shape", async () => {
    const today = { day: '2026-11-13', granted: 3, cap: 30, paused: false };
    const caller = (data: unknown, error: unknown = null) => {
      return adminRouter.createCaller({
        headers: new Headers(), user: { id: 'fixture-admin' }, isEmailVerified: true, authProvider: 'email', hasSupabaseAdminPrivileges: true,
        supabase: profileClient, supabasePublic: profileClient,
        supabaseAdmin: { ...profileClient, rpc: vi.fn(async (fn: string) => { expect(fn).toBe('signup_gift_today'); return { data, error }; }) },
      } as unknown as Parameters<typeof adminRouter.createCaller>[0]);
    };
    await expect(caller(today).getSignupGiftToday()).resolves.toEqual(today);
    await expect(caller({ ...today, granted: -1 }).getSignupGiftToday()).rejects.toThrow();
    await expect(caller(null, { code: '42501' }).getSignupGiftToday()).rejects.toThrow();
  });
});

const profileClient = {
  from(table: string) {
    if (table !== 'profiles') throw new Error(`Unexpected table ${table}`);
    return { select() { return this; }, eq() { return this; },
      single: async () => ({ data: { id: 'fixture-admin', role: 'admin', status: 'active', nickname: 'Fixture', is_deleted: 'false' }, error: null }) };
  },
};
