/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cron: vi.fn(), release: vi.fn(), capture: vi.fn(), auth: vi.fn(), create: vi.fn(), rpc: vi.fn() }));
vi.mock('@repo/api/src/services/subscriptionCreditGrants', () => ({ releaseDueAnnualSubscriptionCredits: mocks.release }));
vi.mock('@repo/api/src/services', () => ({ logger: { system: { cronJob: mocks.cron } } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mocks.capture }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
import { GET } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue(null);
  mocks.rpc.mockReset().mockResolvedValue({ data: 8970, error: null });
  mocks.create.mockReturnValue({ rpc: mocks.rpc });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture');
});
afterEach(() => vi.unstubAllEnvs());
it('returns anomalies and emits a single fixed-code alert without subject identifiers', async () => {
  const anomalies = [{ subscriptionId: 'private-subject', reason: 'PAY_COMMON_ANNUAL_CONTRACT_UNKNOWN' }];
  mocks.release.mockResolvedValue({ anomalies, releasedGrantCount: 1 });
  const response = await GET(new Request('https://fixture.invalid'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.summary).toMatchObject({ anomalyCount: 1, anomalyReasons: ['PAY_COMMON_ANNUAL_CONTRACT_UNKNOWN'] });
  expect(body.summary.methodResult).toEqual({ releasedCredits: 8970 });
  expect(mocks.rpc).toHaveBeenCalledWith('pay_waffo_release_due', { p_limit: 100 });
  expect(body.summary).not.toHaveProperty('anomalies');
  expect(JSON.stringify(body)).not.toContain('private-subject');
  expect(JSON.stringify(mocks.cron.mock.calls)).not.toContain('private-subject');
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  expect(mocks.capture).toHaveBeenCalledWith('PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED', expect.objectContaining({
    extra: { count: 1, reasons: ['PAY_COMMON_ANNUAL_CONTRACT_UNKNOWN'] },
  }));
  expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain('private-subject');
});
it('does not alert on healthy runs and keeps database failures retryable', async () => {
  mocks.release.mockResolvedValue({ anomalies: [], releasedGrantCount: 1 });
  expect((await GET(new Request('https://fixture.invalid'))).status).toBe(200);
  expect(mocks.capture).not.toHaveBeenCalled();
  mocks.release.mockRejectedValue(new Error('database unavailable'));
  expect((await GET(new Request('https://fixture.invalid'))).status).toBe(500);
});
it('keeps internal-membership database failures retryable without returning success', async () => {
  mocks.release.mockResolvedValue({ anomalies: [], releasedGrantCount: 1 });
  mocks.rpc.mockResolvedValue({ data: null, error: { message: 'fixture failure' } });
  const response = await GET(new Request('https://fixture.invalid'));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ success: false });
});
it('does not run or expose a summary without cron authorization', async () => {
  mocks.auth.mockReturnValue(new Response(null, { status: 401 }));
  expect((await GET(new Request('https://fixture.invalid'))).status).toBe(401);
  expect(mocks.release).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
