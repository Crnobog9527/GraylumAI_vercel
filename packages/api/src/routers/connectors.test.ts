/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), disconnect: vi.fn(), rateLimit: vi.fn() }));
vi.mock('../services/redisRateLimiter', () => ({ checkRateLimitOrThrow: mocks.rateLimit }));
vi.mock('../services/connectors/shotviva/connect', async (original) => ({
  ...(await original<typeof import('../services/connectors/shotviva/connect')>()),
  readShotvivaStatus: mocks.status, disconnectShotviva: mocks.disconnect,
}));
import { connectorsRouter } from './connectors';
import { ShotvivaConnectError } from '../services/connectors/shotviva/connect';

const me = '00000000-0000-4000-8000-000000000001';
const profile = { id: me, role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
// protectedProcedure reads the caller's profile first.
const from = () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }),
  maybeSingle: async () => ({ data: profile, error: null }) });
const db = { from, rpc: vi.fn() };
const caller = (user: { id: string } | null = { id: me }, admin = true) => connectorsRouter.createCaller({
  headers: new Headers(), user: user && { ...user, email: 'u@example.com', app_metadata: {}, user_metadata: {} },
  isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db,
  hasSupabaseAdminPrivileges: admin,
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SHOTVIVA_BASE_URL', 'https://shotviva.test');
  mocks.rateLimit.mockResolvedValue({ success: true });
  mocks.status.mockResolvedValue({ available: true, eligible: true, connected: false, balance: null });
  mocks.disconnect.mockResolvedValue({ connected: false });
});

describe('connectors router', () => {
  it('status and disconnect act on the signed-in user only, with the configured Shotviva address', async () => {
    expect(await caller().shotvivaStatus()).toEqual({ available: true, eligible: true, connected: false, balance: null });
    expect(mocks.status).toHaveBeenCalledWith({ admin: db, baseUrl: 'https://shotviva.test', profileId: me });
    expect(mocks.rateLimit).toHaveBeenCalledWith(`shotviva-status:${me}`, 'api');
    expect(await caller().shotvivaDisconnect()).toEqual({ connected: false });
    expect(mocks.disconnect).toHaveBeenCalledWith({ admin: db, profileId: me });
  });

  it('signed out is refused; no service key is "unavailable"; failures are fixed codes', async () => {
    await expect(caller(null).shotvivaStatus()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(null).shotvivaDisconnect()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller({ id: me }, false).shotvivaStatus()).rejects.toMatchObject({ message: 'SHOTVIVA_UNAVAILABLE' });
    mocks.status.mockRejectedValueOnce(new ShotvivaConnectError('SHOTVIVA_ACCOUNT_CLOSED'));
    await expect(caller().shotvivaStatus()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SHOTVIVA_ACCOUNT_CLOSED' });
    mocks.status.mockRejectedValueOnce(new Error('private detail'));
    await expect(caller().shotvivaStatus()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SHOTVIVA_UNAVAILABLE' });
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});
