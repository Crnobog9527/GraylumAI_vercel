/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), turns: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth, createCronServiceClient: mocks.create }));
vi.mock('@repo/api/src/services/turn/fusionRecovery', () => ({ recoverFusionTurns: mocks.turns }));
import { GET } from './route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.turns.mockResolvedValue({ success: true, expired: 0, orphaned: 0, synced: 0, failed: 0 });
});
const request = () => new Request('https://synthetic.test/api/cron/fusion-recovery');

it('denies unauthorized cron before any client or recovery work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(request())).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.turns).not.toHaveBeenCalled();
});
it('runs the turn-path recovery and nothing of the old BILL2 path', async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(mocks.turns).toHaveBeenCalledWith({ synthetic: true });
  expect(await response.json()).toEqual({ turns: { success: true, expired: 0, orphaned: 0, synced: 0, failed: 0 } });
});
it('fails the run when the turn-path step fails', async () => {
  mocks.turns.mockResolvedValueOnce({ success: false, expired: 0, orphaned: 0, synced: 0, failed: 1 });
  expect((await GET(request())).status).toBe(500);
});
it('keeps errors private', async () => {
  mocks.turns.mockRejectedValueOnce(new Error('private diagnostic'));
  const response = await GET(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Fusion recovery failed' });
});
it('does not start when configuration is absent, and is scheduled every ten minutes', async () => {
  mocks.create.mockReturnValue(null);
  expect((await GET(request())).status).toBe(500);
  expect(mocks.turns).not.toHaveBeenCalled();
  const crons = (JSON.parse(readFileSync(new URL('../../../../../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> }).crons;
  expect(crons.find(cron => cron.path === '/api/cron/fusion-recovery')?.schedule).toBe('*/10 * * * *');
});
