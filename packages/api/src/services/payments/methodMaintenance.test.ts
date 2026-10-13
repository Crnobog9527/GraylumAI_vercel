/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { releaseMethodMembershipCredits } from './methodMaintenance';
const byName = (values: Record<string, { data: unknown; error: unknown }>) =>
  vi.fn().mockImplementation((name: string) => Promise.resolve(values[name]));
describe('annual method grant cron', () => {
 it('uses the bounded atomic release independently of sales switches', async () => {
  const rpc = byName({ pay_waffo_release_due: { data: 8970, error: null },
    pay_common_settle_membership_levels: { data: 2, error: null } });
  expect(await releaseMethodMembershipCredits({ rpc })).toEqual({ releasedCredits: 8970, settledMembershipLevels: 2 });
  expect(rpc).toHaveBeenCalledWith('pay_waffo_release_due', { p_limit: 100 });
  expect(rpc).toHaveBeenCalledWith('pay_common_settle_membership_levels', { p_limit: 100 });
 });
 it('fails the cron when the transaction is unavailable instead of claiming a successful zero', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'missing migration' } });
  await expect(releaseMethodMembershipCredits({ rpc })).rejects.toThrow('RELEASE_UNAVAILABLE');
 });
 it('fails the cron when ended memberships cannot be settled', async () => {
  const rpc = byName({ pay_waffo_release_due: { data: 0, error: null },
    pay_common_settle_membership_levels: { data: null, error: { message: 'missing migration' } } });
  await expect(releaseMethodMembershipCredits({ rpc })).rejects.toThrow('PAY_COMMON_SETTLE_UNAVAILABLE');
 });
});
