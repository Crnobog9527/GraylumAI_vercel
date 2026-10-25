/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), recover: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth, createCronServiceClient: mocks.create }));
vi.mock('@repo/api/src/services/fusion/recovery', () => ({ recoverFusionFinancials: mocks.recover }));
import { GET } from './route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.recover.mockResolvedValue({ success: true, scanned: 1, cancelled: 0, recovered: 1, scrubbed: 0, failed: 0, rejudged: 0, deferred: 0 });
});
const request = () => new Request('https://synthetic.test/api/cron/fusion-recovery');

it('denies unauthorized cron before any client or recovery work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(request())).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.recover).not.toHaveBeenCalled();
});
it('runs the Fusion recovery with a grace period for calls that may still be streaming', async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(mocks.recover).toHaveBeenCalledWith({ synthetic: true }, { dispatchedGraceMs: 600_000 });
});
it('fails the run when a call stays pending, and keeps errors private', async () => {
  mocks.recover.mockResolvedValueOnce({ success: false, failed: 1 });
  expect((await GET(request())).status).toBe(500);
  mocks.recover.mockRejectedValueOnce(new Error('private diagnostic'));
  const response = await GET(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Fusion recovery failed' });
});
it('does not start when configuration is absent, and is scheduled every ten minutes', async () => {
  mocks.create.mockReturnValue(null);
  expect((await GET(request())).status).toBe(500);
  expect(mocks.recover).not.toHaveBeenCalled();
  const crons = (JSON.parse(readFileSync(new URL('../../../../../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> }).crons;
  expect(crons.find(cron => cron.path === '/api/cron/fusion-recovery')?.schedule).toBe('*/10 * * * *');
});
