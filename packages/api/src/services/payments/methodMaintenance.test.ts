/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { releaseMethodMembershipCredits } from './methodMaintenance';
describe('annual method grant cron', () => {
 it('uses the bounded atomic release independently of sales switches', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: 8970, error: null });
  expect(await releaseMethodMembershipCredits({ rpc })).toEqual({ releasedCredits: 8970 });
  expect(rpc).toHaveBeenCalledWith('pay_waffo_release_due', { p_limit: 100 });
 });
 it('fails the cron when the transaction is unavailable instead of claiming a successful zero', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'missing migration' } });
  await expect(releaseMethodMembershipCredits({ rpc })).rejects.toThrow('RELEASE_UNAVAILABLE');
 });
});
