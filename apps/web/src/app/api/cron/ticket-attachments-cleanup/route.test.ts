/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn(), cleanup: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ validateCronRequest: mocks.auth }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
vi.mock('@repo/api/src/services/ticketAttachmentCleanup', () => ({ runTicketAttachmentCleanup: mocks.cleanup }));
import { GET } from './route';
const url = 'https://synthetic.test/api/cron/ticket-attachments-cleanup';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-value');
  mocks.create.mockReturnValue({ synthetic: true });
  mocks.cleanup.mockResolvedValue({ removed: 3, failed: 0, more: false });
});
it('denies unauthorized cron before any client or cleanup work', async () => {
  mocks.auth.mockReturnValue(new Response('Unauthorized', { status: 401 }));
  expect((await GET(new Request(url))).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.cleanup).not.toHaveBeenCalled();
});
it('uses the existing cron auth and returns counts only', async () => {
  const request = new Request(url);
  const response = await GET(request);
  expect(mocks.auth).toHaveBeenCalledWith(request, 'ticket_attachments_cleanup');
  expect(await response.json()).toEqual({ success: true, removed: 3, failed: 0, more: false });
});
it('reports partial removal and keeps provider errors private', async () => {
  mocks.cleanup.mockResolvedValueOnce({ removed: 1, failed: 2, more: false });
  expect((await GET(new Request(url))).status).toBe(500);
  mocks.cleanup.mockRejectedValueOnce(new Error('private storage diagnostic'));
  const response = await GET(new Request(url));
  expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'Ticket attachment cleanup failed' });
});
it('does not start when configuration is absent', async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  expect((await GET(new Request(url))).status).toBe(500); expect(mocks.cleanup).not.toHaveBeenCalled();
});
it('runs once a day', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.crons).toContainEqual({ path: '/api/cron/ticket-attachments-cleanup', schedule: '30 3 * * *' });
});
