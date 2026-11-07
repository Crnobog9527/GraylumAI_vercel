/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  readStopLoss: vi.fn(async () => ({ config: { providerBalanceAlertUsd: null, siteDailyUsd: null, siteAlertUsd: null } })),
  deliver: vi.fn(async () => ({ outcome: 'none', alerts: 0 })),
  test: vi.fn(async () => 'sent' as const),
}));
vi.mock('./stopLossSettings', () => ({ readStopLoss: m.readStopLoss, usdThreshold: { optional: () => ({}) } }));
vi.mock('./stopLossNotify', () => ({ deliverStopLossAlerts: m.deliver }));
vi.mock('../../ownerAlerts/notify', () => ({ sendOwnerAlertTest: m.test }));
import { testRuntimeStopLoss } from './stopLossMonitor';

const ctx = (runType: 'manual' | 'cron') => ({ supabase: {}, supabaseAdmin: { rpc: vi.fn(async () => ({ data: { siteUsd: '0' }, error: null })) },
  runType }) as never;

beforeEach(() => { vi.clearAllMocks(); });

it('ALERT-FEISHU: an admin running the check by hand sends one Feishu test message and shows the outcome', async () => {
  const result = await testRuntimeStopLoss(ctx('manual'));
  expect(m.test).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('passed');
  expect(result.details).toMatchObject({ ownerAlert: 'sent', externalNotifications: 'email+feishu' });
});

it('the daily cron run never sends the test message', async () => {
  const result = await testRuntimeStopLoss(ctx('cron'));
  expect(m.test).not.toHaveBeenCalled();
  expect(result.details).not.toHaveProperty('ownerAlert');
});
