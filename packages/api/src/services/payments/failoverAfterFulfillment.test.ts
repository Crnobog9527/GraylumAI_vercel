/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, expect, it, vi } from 'vitest';
const actions = vi.hoisted(() => ({ client: vi.fn(), observe: vi.fn(), stop: vi.fn() }));
vi.mock('../stripe', () => ({ getStripeClient: actions.client }));
vi.mock('./cardUpgrade', () => ({ observeUpgradePrior: actions.observe, stopPriorAfterUpgrade: actions.stop }));
import { afterWaffoFulfillment, observeFailoverUpgrade } from './failoverAfterFulfillment';
function database(values: unknown[]) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: values.shift(), error: null }) };
  return { from: () => q } as never;
}
beforeEach(() => { vi.resetAllMocks(); actions.client.mockReturnValue({ bounded: true }); });
it('does not require Stripe for an ordinary paid Waffo purchase', async () => {
  actions.client.mockImplementation(() => { throw new Error('Stripe unavailable'); });
  await expect(afterWaffoFulfillment(database([{ method_transition: null }]), 'order')).resolves.toBeUndefined();
  expect(actions.client).not.toHaveBeenCalled();
});
it('does not contact Stripe for an upgrade of an already nonrenewing wallet membership', async () => {
  actions.client.mockImplementation(() => { throw new Error('Stripe unavailable'); });
  await observeFailoverUpgrade(database([{ payment_channel: 'stripe', cancel_at_period_end: true }]), 'user', 'prior');
  await afterWaffoFulfillment(database([{ method_transition: 'upgrade', method_prior_subscription: 'prior' },
    { payment_channel: 'stripe', cancel_at_period_end: 'true' }]), 'order');
  expect(actions.client).not.toHaveBeenCalled(); expect(actions.stop).not.toHaveBeenCalled();
});
it('observes a still-renewing Stripe source before accepting an emergency upgrade', async () => {
  const db = database([{ payment_channel: 'stripe', cancel_at_period_end: false }]);
  await observeFailoverUpgrade(db, 'user', 'prior');
  expect(actions.client).toHaveBeenCalledWith({ timeout: 2000, maxNetworkRetries: 0 });
  expect(actions.observe).toHaveBeenCalledWith(db, { bounded: true }, 'user', 'prior');
});
it('leaves a failed original-provider stop retryable after cash fulfillment', async () => {
  actions.stop.mockRejectedValue(new Error('provider outage'));
  const order = { method_transition: 'upgrade', method_prior_subscription: 'prior' };
  const db = database([order, { payment_channel: 'stripe', cancel_at_period_end: false }]);
  await expect(afterWaffoFulfillment(db, 'order')).rejects.toThrow('provider outage');
  expect(actions.stop).toHaveBeenCalledWith(db, { bounded: true }, order);
});
it('does not start a provider stop after the cron budget expires', async () => {
  const db = database([{ method_transition: 'upgrade', method_prior_subscription: 'prior' },
    { payment_channel: 'stripe', cancel_at_period_end: false }]);
  await expect(afterWaffoFulfillment(db, 'order', Date.now() - 1)).rejects.toThrow('RECONCILIATION_REQUIRED');
  expect(actions.client).not.toHaveBeenCalled();
});
