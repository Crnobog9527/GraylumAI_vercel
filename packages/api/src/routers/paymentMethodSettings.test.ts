/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { inferRouterContext } from '@trpc/server';
import { settingsRouter } from './settings';
import { PAYMENT_METHOD_ROUTES_KEY as key } from '../services/payments/methodRouting';

const closed = { version: 1, card: { enabled: false },
  wechat_pay: { enabled: false, annualVerified: false }, alipay: { enabled: false, annualVerified: false } };
function fixture(options: { role?: string; value?: unknown; error?: unknown; writerActive?: boolean } = {}) {
  const profile = { id: 'fixture-admin', nickname: 'Fixture', email: 'fixture@example.test',
    role: options.role ?? 'admin', status: 'active', is_deleted: 'false', membership_level: 'free' };
  const upsert = vi.fn().mockReturnValue({ select: async () => ({ data: [], error: options.error ?? null }) });
  const read = vi.fn().mockResolvedValue({ data: options.value === undefined ? null : { value: options.value },
    error: options.error ?? null });
  let profileReads = 0;
  const db = { from: (table: string) => table === 'system_settings'
    ? { upsert, select() { return this; }, eq: vi.fn().mockReturnValue({ maybeSingle: read }) }
    : { select() { return this; }, eq() { return this; }, single: async () => {
      profileReads += 1;
      return { data: { ...profile, status: options.writerActive === false && profileReads > 1 ? 'suspended' : 'active' }, error: null };
    } } };
  const context = { headers: new Headers(), user: { id: profile.id, email: profile.email,
    app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', hasSupabaseAdminPrivileges: true,
    supabase: db, supabasePublic: db, supabaseAdmin: db,
  } as unknown as inferRouterContext<typeof settingsRouter>;
  return { caller: settingsRouter.createCaller(context), context, upsert, read };
}
it('reads absent configuration without initializing or enabling sales', async () => {
  const f = fixture();
  await expect(f.caller.getPaymentMethodRoutes()).resolves.toBeNull();
  expect(f.upsert).not.toHaveBeenCalled();
});
it('reads all independent switches and their authoritative version', async () => {
  const value = { ...closed, version: 7, alipay: { enabled: true, annualVerified: true } };
  await expect(fixture({ value }).caller.getPaymentMethodRoutes()).resolves.toEqual(value);
});
it.each([{ error: { message: 'private fixture detail' } }, { value: { version: 2 } }])
('fails closed with a safe error on unavailable or malformed stored configuration', async options => {
  await expect(fixture(options).caller.getPaymentMethodRoutes()).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE', message: '付款方式配置暂时无法读取，请稍后重试',
  });
});
it.each(['single', 'bulk'])('validates %s saves before any write', async mode => {
  const f = fixture();
  for (const value of [null, { ...closed, version: 0 }, { ...closed, version: 1.5 }, { ...closed, version: 10000000000 },
    { ...closed, channel: 'stripe' }, { ...closed, card: { enabled: 'true' } },
    { ...closed, alipay: { enabled: true } }, { ...closed, wechat_pay: { enabled: true, annualVerified: 'true' } }]) {
    const input = { key, value };
    await expect(mode === 'single' ? f.caller.updateSystemSettings(input) : f.caller.updateSystemSettingsBulk([input]))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
  expect(f.upsert).not.toHaveBeenCalled();
});
it.each(['single', 'bulk'])('preserves version and switches in one %s database write', async mode => {
  const f = fixture();
  const input = { key, value: { ...closed, version: 4, wechat_pay: { enabled: true, annualVerified: false } } };
  const batch = [input, { key: 'site_name', value: 'Fixture' }];
  await (mode === 'single' ? f.caller.updateSystemSettings(input) : f.caller.updateSystemSettingsBulk(batch));
  expect(f.upsert).toHaveBeenCalledExactlyOnceWith(mode === 'single' ? input : batch, { onConflict: 'key' });
});
it.each(['updateSystemSettings', 'updateSystemSettingsBulk'] as const)
('propagates the transaction version conflict as HTTP 409 without retry: %s', async path => {
  const f = fixture({ error: { code: 'PT409', message: 'private fixture detail' } });
  const input = { key, value: closed };
  const response = await fetchRequestHandler({ endpoint: '/trpc', router: settingsRouter, createContext: () => f.context,
    req: new Request(`http://localhost/trpc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(path === 'updateSystemSettings' ? input : [input]) }),
  });
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain('private fixture detail');
  expect(f.upsert).toHaveBeenCalledTimes(1);
});
it('denies ordinary users and revoked writers without reading or saving routes', async () => {
  const f = fixture({ role: 'user' });
  await expect(f.caller.getPaymentMethodRoutes()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  for (const blocked of [f, fixture({ writerActive: false })]) {
    await expect(blocked.caller.updateSystemSettings({ key, value: closed })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(blocked.caller.updateSystemSettingsBulk([{ key, value: closed }])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(blocked.upsert).not.toHaveBeenCalled();
  }
  expect(f.read).not.toHaveBeenCalled();
});
it('denies anonymous reads and both write endpoints', async () => {
  const context = { headers: new Headers(), user: null } as unknown as inferRouterContext<typeof settingsRouter>;
  const caller = settingsRouter.createCaller(context);
  await expect(caller.getPaymentMethodRoutes()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(caller.updateSystemSettings({ key, value: closed })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(caller.updateSystemSettingsBulk([{ key, value: closed }])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
