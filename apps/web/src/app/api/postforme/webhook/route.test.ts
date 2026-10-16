/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ client: vi.fn(), secret: vi.fn(), handle: vi.fn() }));
vi.mock('@repo/api/src/services/stripe', () => ({ createServiceRoleSupabaseClient: mocks.client }));
vi.mock('@repo/api/src/services/publishMonitor/secrets', () => ({ readPostForMeWebhookSecret: mocks.secret }));
vi.mock('@repo/api/src/services/publishMonitor/webhook', () => ({ handlePostForMeWebhook: mocks.handle }));
import { POST } from './route';
const call = () => POST(new Request('https://synthetic.test/api/postforme/webhook', { method: 'POST' }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.client.mockReturnValue({ rpc: 'synthetic' });
});
it('passes the admin client and Vault secret to the authenticated handler', async () => {
  mocks.secret.mockResolvedValue('fake-webhook-secret-test');
  mocks.handle.mockResolvedValue({ status: 200, body: { ok: true } });
  expect((await call()).status).toBe(200);
  expect(mocks.secret).toHaveBeenCalledWith({ rpc: 'synthetic' });
  expect(mocks.handle.mock.calls[0]![1]).toBe('fake-webhook-secret-test');
  expect(mocks.handle.mock.calls[0]![2]()).toEqual({ rpc: 'synthetic' });
});
it('keeps missing configuration distinct from unavailable Vault', async () => {
  mocks.secret.mockResolvedValue(null);
  mocks.handle.mockResolvedValue({ status: 503, body: { ok: false, error: 'NOT_CONFIGURED' } });
  expect(await (await call()).json()).toEqual({ ok: false, error: 'NOT_CONFIGURED' });
  mocks.handle.mockClear();
  mocks.secret.mockRejectedValue(new Error('PLATFORM_SECRET_UNAVAILABLE'));
  const res = await call();
  expect([res.status, await res.json()]).toEqual([503, { ok: false, error: 'UNAVAILABLE' }]);
  expect(mocks.handle).not.toHaveBeenCalled();
});
