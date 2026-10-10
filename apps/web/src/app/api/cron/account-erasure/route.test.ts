/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), recover: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@repo/api/src/services/accountErasure/executor', () => ({ runAccountErasureExecutor: mocks.recover }));
import { GET } from './route';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-value');
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.recover.mockResolvedValue({ processed: 1, completed: 1, pending: 0, failed: 0 });
});
it('denies unauthenticated cron before inventory or provider work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(new Request('https://synthetic.test/api/cron/account-erasure'))).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
});
it('runs the bounded recovery through the existing authenticated cron entry', async () => {
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure?actorId=ignored'));
  expect(response.status).toBe(200);
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'account-erasure');
  expect(mocks.recover).toHaveBeenCalledWith({ synthetic: true });
  expect(await response.json()).toEqual({ success: true, processed: 1, completed: 1, pending: 0, failed: 0 });
});
it('reports sanitized failure without raw provider or database content', async () => {
  mocks.recover.mockRejectedValue(new Error('synthetic private diagnostic'));
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Account erasure failed' });
});
it('does not query when required configuration is unavailable', async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  expect((await GET(new Request('https://synthetic.test/api/cron/account-erasure'))).status).toBe(500);
  expect(mocks.recover).not.toHaveBeenCalled();
});
it('reports cleanup retry as pending rather than success', async () => {
  mocks.recover.mockResolvedValue({ processed: 1, completed: 0, pending: 1, failed: 0 });
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ success: false, processed: 1, completed: 0, pending: 1, failed: 0 });
});
it('uses daily 05:00 UTC cleanup without overlapping existing cron schedules', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.crons).toContainEqual({ path: '/api/cron/account-erasure', schedule: '0 5 * * *' });
  expect(config.crons.filter((cron: { path: string }) => cron.path !== '/api/cron/account-erasure')
    .map((cron: { schedule: string }) => cron.schedule)).toEqual(['0 2 * * *', '0 3 * * *', '0 4 * * *', '0 10 * * *', '0 6 * * *']);
});
