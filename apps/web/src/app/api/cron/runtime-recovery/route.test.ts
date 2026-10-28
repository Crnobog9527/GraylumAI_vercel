/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), recover: vi.fn(), notice: vi.fn(), start: vi.fn(), finish: vi.fn(), turns: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@repo/api/src/services/runtime/automaticRecovery', () => ({ runAutomaticFinancialRecovery: mocks.recover }));
vi.mock('@repo/api/src/services/runtime/stopLossNotify', () => ({ deliverStopLossAlerts: mocks.notice }));
vi.mock('@repo/api/src/services/turn/recovery', () => ({ runTurnRecovery: mocks.turns }));
vi.mock('@repo/api/src/services/scheduledJobRuns', () => ({ startScheduledJobRun: mocks.start, finishScheduledJobRun: mocks.finish }));
import { GET } from './route';
const TURNS = { claimed: 2, interrupted: 1, expired: 1, settled: 0, pending: 0, skipped: 0, lookups: 0, lateReceipts: 0, failed: 0 };
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-value');
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.recover.mockResolvedValue({ selected: 1, processed: 1, settled: 1, pending: 0, failed: 0 });
  mocks.notice.mockResolvedValue({ outcome: 'none', alerts: 0 });
  mocks.start.mockResolvedValue('run-1');
  mocks.finish.mockResolvedValue(undefined);
  mocks.turns.mockResolvedValue(TURNS);
});
it('denies unauthenticated cron before inventory or provider work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'))).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
  expect(mocks.notice).not.toHaveBeenCalled();
});
it('runs the bounded recovery through the existing authenticated cron entry', async () => {
  const response = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery?actorId=ignored'));
  expect(response.status).toBe(200);
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'runtime-recovery');
  expect(mocks.recover).toHaveBeenCalledWith({ synthetic: true });
  expect(await response.json()).toEqual({ success: true, selected: 1, processed: 1, settled: 1, pending: 0, failed: 0, turns: TURNS });
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
it('is scheduled every minute (Pro) so stuck rounds are closed automatically', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.crons).toContainEqual({ path: '/api/cron/runtime-recovery', schedule: '* * * * *' });
  expect(config.crons).toContainEqual({ path: '/api/cron/billing-reconcile', schedule: '0 4 * * *' });
});
it('reports the automatic stale-round close and fails while any of its refunds is unconfirmed', async () => {
  const staleRounds = { found: 2, compensated: 1, alreadyCompensated: 0, skipped: 0, failed: 1, credits: 3, manualReview: 0, deferred: 0 };
  mocks.recover.mockResolvedValue({ selected: 0, processed: 0, settled: 0, pending: 0, failed: 0, staleRounds });
  const response = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ success: false, selected: 0, processed: 0, settled: 0, pending: 0, failed: 0, staleRounds, turns: TURNS });
});
// CORE-PATH-V2 V2-8: the turns recovery runs in the same job, beside the old one, and ends before the route limit.
it('runs the turns recovery beside the old recovery and fails while a turn could not be recovered', async () => {
  const before = Date.now();
  expect((await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'))).status).toBe(200);
  expect(mocks.turns).toHaveBeenCalledWith({ synthetic: true }, expect.any(Number));
  const deadline = mocks.turns.mock.calls[0]![1] as number;
  expect(deadline - before).toBeGreaterThanOrEqual(55_000);
  expect(deadline - Date.now()).toBeLessThanOrEqual(55_000);
  mocks.turns.mockResolvedValue({ ...TURNS, failed: 1 });
  const failed = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(failed.status).toBe(500);
  expect((await failed.json()).turns.failed).toBe(1);
});
it('fails while reported stale-round refunds were deferred by the time budget', async () => {
  const staleRounds = { found: 5, compensated: 2, alreadyCompensated: 0, skipped: 0, failed: 0, credits: 6, manualReview: 0, deferred: 3 };
  mocks.recover.mockResolvedValue({ selected: 0, processed: 0, settled: 0, pending: 0, failed: 0, staleRounds });
  expect((await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'))).status).toBe(500);
});
it('mails stop-loss alerts before recovery, bounded, and even when recovery fails, without changing its status', async () => {
  mocks.notice.mockResolvedValue({ outcome: 'not_sent', alerts: 2, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' });
  const ok = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(ok.status).toBe(200);
  expect(mocks.notice).toHaveBeenCalledWith({ synthetic: true });
  expect(mocks.notice.mock.invocationCallOrder[0]).toBeLessThan(mocks.recover.mock.invocationCallOrder[0]!);
  mocks.recover.mockRejectedValue(new Error('synthetic'));
  expect((await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'))).status).toBe(500);
  expect(mocks.notice).toHaveBeenCalledTimes(2);
});

// Line D1: each run leaves its counts in scheduled_job_runs; recording never blocks or fails the recovery.
it('records every run with its counts, success or failure', async () => {
  await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(mocks.start).toHaveBeenCalledWith({ supabase: { synthetic: true }, jobKey: 'runtime_recovery', triggerSource: 'cron' });
  expect(mocks.finish).toHaveBeenCalledWith({ supabase: { synthetic: true }, runId: 'run-1', status: 'success',
    summary: { selected: 1, processed: 1, settled: 1, pending: 0, failed: 0, turns: TURNS }, error: undefined });
  mocks.finish.mockClear();
  mocks.recover.mockRejectedValue(new Error('synthetic private diagnostic'));
  await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(mocks.finish).toHaveBeenCalledWith({ supabase: { synthetic: true }, runId: 'run-1', status: 'error', summary: {},
    error: 'RUNTIME_RECOVERY_FAILED' });
});
it('still recovers when the run record cannot be written', async () => {
  mocks.start.mockRejectedValue(new Error('Failed to start scheduled job run'));
  const response = await GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
  expect(response.status).toBe(200);
  expect(mocks.recover).toHaveBeenCalledOnce();
  expect(mocks.finish).not.toHaveBeenCalled();
});

it('gives up a run-record write that does not answer, so the recovery keeps its budget', async () => {
  vi.useFakeTimers();
  try {
    mocks.start.mockReturnValue(new Promise(() => {}));
    const pending = GET(new Request('https://synthetic.test/api/cron/runtime-recovery'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.finish).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
