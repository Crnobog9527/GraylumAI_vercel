/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), recover: vi.fn(), sweep: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@repo/api/src/services/accountErasure/executor', () => ({ runAccountErasureExecutor: mocks.recover }));
vi.mock('@repo/api/src/services/accountErasure/content', () => ({ sweepErasedConversations: mocks.sweep }));
import { GET } from './route';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-value');
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.recover.mockResolvedValue({ processed: 1, completed: 1, pending: 0, failed: 0 });
  mocks.sweep.mockResolvedValue({ cleaned: 2, pending: 0, failed: 0, more: false });
});
it('denies unauthenticated cron before inventory or provider work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(new Request('https://synthetic.test/api/cron/account-erasure'))).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.sweep).not.toHaveBeenCalled();
});
it('runs the bounded recovery through the existing authenticated cron entry', async () => {
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure?actorId=ignored'));
  expect(response.status).toBe(200);
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'account-erasure');
  expect(mocks.recover).toHaveBeenCalledWith({ synthetic: true }, expect.any(Number));
  // The conversation sweep runs first in a hard 12s budget; account erasure keeps 45s from the start.
  const [, executorDeadline] = mocks.recover.mock.calls[0];
  const [sweepClient, sweepDeadline] = mocks.sweep.mock.calls[0];
  expect(sweepClient).toEqual({ synthetic: true });
  expect(executorDeadline - sweepDeadline).toBe(33_000);
  expect(sweepDeadline - Date.now()).toBeLessThanOrEqual(12_000);
  expect(mocks.sweep.mock.invocationCallOrder[0]).toBeLessThan(mocks.recover.mock.invocationCallOrder[0]);
  expect(await response.json()).toEqual({ success: true, processed: 1, completed: 1, pending: 0, failed: 0,
    conversations: { cleaned: 2, pending: 0, failed: 0, more: false } });
});

it.each([
  [{ cleaned: 0, pending: 0, failed: 1, more: false }, 'a permanent cleanup failure'],
  [{ cleaned: 1, pending: 1, failed: 0, more: false }, 'a conversation still busy after the retries'],
  [{ cleaned: 50, pending: 0, failed: 0, more: true }, 'a backlog left after the time budget'],
])('fails the run for %s', async (conversations) => {
  mocks.sweep.mockResolvedValue(conversations);
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure'));
  expect(response.status).toBe(500);
  expect((await response.json())).toMatchObject({ success: false, conversations });
});
it('reports a failed conversation sweep as a sanitized failure', async () => {
  mocks.sweep.mockRejectedValue(new Error('synthetic private diagnostic'));
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure'));
  expect(response.status).toBe(500);
  expect(mocks.recover).toHaveBeenCalledTimes(1);
  expect(await response.json()).toEqual({ error: 'Account erasure failed' });
});
it('still sweeps deleted conversations when account erasure has a backlog', async () => {
  mocks.recover.mockResolvedValue({ processed: 9, completed: 0, pending: 30, failed: 0 });
  const response = await GET(new Request('https://synthetic.test/api/cron/account-erasure'));
  expect(mocks.sweep).toHaveBeenCalledTimes(1);
  expect((await response.json()).conversations).toEqual({ cleaned: 2, pending: 0, failed: 0, more: false });
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
  expect(await response.json()).toEqual({ success: false, processed: 1, completed: 0, pending: 1, failed: 0,
    conversations: { cleaned: 2, pending: 0, failed: 0, more: false } });
});
it('runs every 5 minutes (Pro) so deletion finishes within the 24-hour promise', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.crons).toContainEqual({ path: '/api/cron/account-erasure', schedule: '*/5 * * * *' });
});
