/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), deps: vi.fn(), run: vi.fn(), start: vi.fn(), finish: vi.fn(), budget: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@repo/api/src/services/publishMonitor/secrets', () => ({ loadPostForMeDeps: mocks.deps }));
vi.mock('@repo/api/src/services/publishMonitor/socialMonitorJob', () => ({ runSocialMonitorJob: mocks.run, createRuntimeBudget: mocks.budget,
  tikhubEntitlements: () => async () => ({ windowDays: 30, benchmark: false }),
  entitlementWindow: () => async () => 30 }));
vi.mock('@repo/api/src/services/scheduledJobRuns', () => ({ startScheduledJobRun: mocks.start,
  finishScheduledJobRun: mocks.finish }));
import { GET } from './route';

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-value');
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.deps.mockResolvedValue({ synthetic: 'deps' });
  mocks.start.mockResolvedValue('run-1');
  mocks.finish.mockResolvedValue(undefined);
  mocks.budget.mockReturnValue({ synthetic: 'one-invocation-budget' });
});
const call = () => GET(new Request('https://synthetic.test/api/cron/social-monitor'));

it('denies an unauthenticated call before any work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await call()).status).toBe(401);
  expect(mocks.run).not.toHaveBeenCalled();
});

it('without a Post for Me key still runs the job (retention, held credits, TikHub) with no Post for Me client', async () => {
  mocks.deps.mockResolvedValue(null);
  mocks.run.mockResolvedValue({ postForMe: false, failures: [] });
  const res = await call();
  expect([res.status, await res.json()]).toEqual([200, { success: true, postForMe: false, failures: [] }]);
  expect(mocks.run.mock.calls[0]![1]).toBeNull();
  expect(mocks.run.mock.calls[0]![5]).toMatchObject({ env: expect.any(Object) });
  expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', status: 'success' }));
});

it('runs the job within its 240-second budget and fails the run when a step failed', async () => {
  const now = Date.now();
  mocks.run.mockResolvedValue({ providerWork: null, attempts: null, sweep: null, sweepDeleteEnabled: false,
    failures: ['sweep'] });
  const res = await call();
  expect(res.status).toBe(500);
  const until = mocks.run.mock.calls[0]![2] as number;
  expect(until - now).toBeGreaterThanOrEqual(239_000);
  expect(until - now).toBeLessThanOrEqual(241_000);
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ jobKey: 'social_monitor', triggerSource: 'cron' }));
  expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', status: 'error',
    error: 'FAILED_STEPS:sweep' }));
});

it('a configured but invalid key fails the run, yet held-credit recovery and retention still run without a client', async () => {
  mocks.deps.mockRejectedValue(new Error('POSTFORME_KEY_INVALID'));
  mocks.run.mockResolvedValue({ failures: [], billedRunsClosed: 2 });
  expect((await call()).status).toBe(500);
  expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: 'POSTFORME_KEY_INVALID' }));
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.run.mock.calls[0]![1]).toBeNull();
});

it('a failed run-record write fails the response instead of reporting success', async () => {
  mocks.run.mockResolvedValue({ providerWork: null, attempts: null, sweep: null, sweepDeleteEnabled: false, failures: [] });
  mocks.finish.mockRejectedValueOnce(new Error('write failed'));
  expect((await call()).status).toBe(500);
});

it('is scheduled once a day, apart from the other daily jobs', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.crons).toContainEqual({ path: '/api/cron/social-monitor', schedule: '0 7 * * *' });
  const hours = config.crons.map((c: { schedule: string }) => c.schedule);
  expect(new Set(hours).size).toBe(hours.length);
});

it('records unavailable Vault as an error, never as an unconfigured successful skip, and still runs the key-free steps', async () => {
  mocks.deps.mockRejectedValue(new Error('PLATFORM_SECRET_UNAVAILABLE'));
  mocks.run.mockResolvedValue({ failures: [] });
  const res = await call();
  expect(res.status).toBe(500);
  expect(mocks.deps).toHaveBeenCalledWith({ synthetic: true });
  expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: 'PLATFORM_SECRET_UNAVAILABLE' }));
  expect(mocks.run.mock.calls[0]![1]).toBeNull();
});

it('shares the entry-time Runtime budget even when setup has already consumed invocation time',async()=>{
 let time=1_000;const clock=vi.spyOn(Date,'now').mockImplementation(()=>time);
 mocks.start.mockImplementationOnce(async()=>{time+=20_000;return 'run-1';});
 mocks.deps.mockImplementationOnce(async()=>{time+=20_000;return null;});
 mocks.run.mockResolvedValue({failures:[]});
 try{
  expect((await call()).status).toBe(200);
  expect(mocks.run.mock.calls[0]![2]).toBe(241_000);
  expect(mocks.budget).toHaveBeenCalledOnce();
  expect(mocks.budget.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
  expect(mocks.run.mock.calls[0]![6].budget).toBe(mocks.budget.mock.results[0]!.value);
 }finally{clock.mockRestore();}
});
