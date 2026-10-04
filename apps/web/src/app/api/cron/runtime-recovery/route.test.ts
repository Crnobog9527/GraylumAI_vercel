/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), recover: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@repo/api/src/services/runtime/automaticRecovery', () => ({ runAutomaticFinancialRecovery: mocks.recover }));
import { GET } from './route';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-value');
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.recover.mockResolvedValue({ selected: 1, processed: 1, settled: 1, pending: 0, failed: 0 });
});
it('denies unauthenticated cron before inventory or provider work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'))).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
});
it('runs the bounded recovery through the existing authenticated cron entry', async () => {
  const response = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery?actorId=ignored'));
  expect(response.status).toBe(200);
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'runtime-recovery');
  expect(mocks.recover).toHaveBeenCalledWith({ synthetic: true });
  expect(await response.json()).toEqual({ success: true, selected: 1, processed: 1, settled: 1, pending: 0, failed: 0 });
});
it('reports sanitized failure without raw provider or database content', async () => {
  mocks.recover.mockRejectedValue(new Error('synthetic private diagnostic'));
  const response = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Runtime recovery failed' });
});
it('does not query when required configuration is unavailable', async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  expect((await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'))).status).toBe(500);
  expect(mocks.recover).not.toHaveBeenCalled();
});
it('keeps the unapproved minute schedule disabled on the current plan', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.crons.some((cron: { path: string }) => cron.path === '/api/cron/runtime-recovery')).toBe(false);
  expect(config.crons).toContainEqual({ path: '/api/cron/billing-reconcile', schedule: '0 4 * * *' });
});
