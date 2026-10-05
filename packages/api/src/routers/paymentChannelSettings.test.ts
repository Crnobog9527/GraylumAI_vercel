/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { settingsRouter } from './settings';
import { paymentsRouter } from './payments';
import { PAYMENT_CHANNEL_KEY } from '../services/payments/channelSettings';
function fixture(role = 'admin', error: unknown = null) {
  const profile = { id: 'fixture-admin', nickname: 'Fixture', email: 'fixture@example.test', role, status: 'active', is_deleted: 'false', membership_level: 'free' };
  const upsert = vi.fn().mockReturnValue({ select: async () => ({ data: [], error }) });
  const db = { from: (table: string) => table === 'system_settings' ? { upsert }
    : { select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) } };
  const context = { headers: new Headers(), user: { id: profile.id, email: profile.email,
    app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', hasSupabaseAdminPrivileges: true,
    supabase: db, supabasePublic: db, supabaseAdmin: db,
  } as unknown as Parameters<typeof settingsRouter.createCaller>[0];
  return { caller: settingsRouter.createCaller(context), context, upsert };
}
it.each(['single', 'bulk'])('validates channel enum/version for %s writes and blocks rate-limit overwrite', async mode => {
  const { caller, upsert } = fixture();
  for (const value of ['stripe', { channel: 'other', version: 1 }, { channel: 'stripe', version: 0 }]) {
    const input = { key: PAYMENT_CHANNEL_KEY, value };
    await expect(mode === 'single' ? caller.updateSystemSettings(input) : caller.updateSystemSettingsBulk([input]))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
  await expect(caller.updateSystemSettingsBulk([{ key: PAYMENT_CHANNEL_KEY, value: { channel: 'stripe', version: 1 } },
    { key: 'runtime_rate_limits', value: {} }])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(upsert).not.toHaveBeenCalled();
});
it.each(['single', 'bulk'].flatMap(mode => ['40001', 'PT409'].map(code => [mode, code])))
('returns a safe conflict for %s stale-version saves (%s)', async (mode, code) => {
  const { caller, upsert } = fixture('admin', { code, message: 'internal detail' });
  const input = { key: PAYMENT_CHANNEL_KEY, value: { channel: 'stripe', version: 1 } };
  await expect(mode === 'single' ? caller.updateSystemSettings(input) : caller.updateSystemSettingsBulk([input]))
    .rejects.toMatchObject({ code: 'CONFLICT', message: '支付渠道已被修改，请刷新后重新保存' });
  expect(upsert).toHaveBeenCalledTimes(1);
});

it.each(['updateSystemSettings', 'updateSystemSettingsBulk'] as const)
('returns HTTP 409 over the tRPC adapter for %s without retry', async path => {
  const { context, upsert } = fixture('admin', { code: 'PT409', message: 'private fixture detail' });
  const input = { key: PAYMENT_CHANNEL_KEY, value: { channel: 'stripe', version: 1 } };
  const response = await fetchRequestHandler({
    endpoint: '/trpc', router: settingsRouter, createContext: () => context,
    req: new Request(`http://localhost/trpc/${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(path === 'updateSystemSettings' ? input : [input]),
    }),
  });
  expect(response.status).toBe(409);
  const text = await response.text();
  expect(JSON.parse(text).error.data.code).toBe('CONFLICT');
  expect(text).not.toContain('private fixture detail');
  expect(upsert).toHaveBeenCalledTimes(1);
});
it('uses one atomic upsert for a valid mixed batch and denies non-admins', async () => {
  const { caller, upsert } = fixture();
  const input = [{ key: PAYMENT_CHANNEL_KEY, value: { channel: 'stripe', version: 1 } }, { key: 'site_name', value: 'Fixture' }];
  await caller.updateSystemSettingsBulk(input);
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(upsert).toHaveBeenCalledWith(input, { onConflict: 'key' });
  const denied = fixture('user');
  await expect(denied.caller.updateSystemSettingsBulk(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(denied.upsert).not.toHaveBeenCalled();
});

it('denies anonymous settings and admin orders without touching the database', async () => {
  const context = { headers: new Headers(), user: null } as unknown as Parameters<typeof settingsRouter.createCaller>[0];
  await expect(settingsRouter.createCaller(context).getPaymentChannel()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(paymentsRouter.createCaller(context).listAdminOrders()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
