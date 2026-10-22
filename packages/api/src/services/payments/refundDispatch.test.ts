/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, expect, it, vi } from 'vitest';
const providers = vi.hoisted(() => ({ stripe: vi.fn(), waffo: vi.fn() }));
vi.mock('../stripe', () => ({ getStripeClient: providers.stripe }));
vi.mock('./waffoTestOperationsClient', () => ({ getWaffoOperationsClient: providers.waffo }));
import { dispatchOrderRefund } from './refundDispatch';
function database(channel: string, mode = 'test') {
  const q = { select: () => q, eq: () => q,
    single: async () => ({ data: { payment_channel: channel, payment_mode: mode }, error: null }) };
  return { from: vi.fn(() => q) } as never;
}
beforeEach(() => { vi.resetAllMocks(); providers.waffo.mockReturnValue({ mode: 'test' }); });
it('refunds an original Waffo order even while Stripe is offline and new sales use Stripe', async () => {
  providers.stripe.mockImplementation(() => { throw new Error('Stripe unavailable'); });
  const stripe = vi.fn(), waffo = vi.fn(async () => ({ status: 'succeeded' }));
  await expect(dispatchOrderRefund(database('waffo'), 'order', stripe, waffo)).resolves.toEqual({ status: 'succeeded' });
  expect(providers.stripe).not.toHaveBeenCalled(); expect(stripe).not.toHaveBeenCalled();
  expect(providers.waffo).toHaveBeenCalledWith('test'); expect(waffo).toHaveBeenCalledOnce();
});
it('keeps original Stripe refunds at Stripe regardless of emergency new-sale settings', async () => {
  providers.stripe.mockReturnValue({ originalStripe: true });
  const stripe = vi.fn(async () => ({ status: 'pending' })), waffo = vi.fn();
  await expect(dispatchOrderRefund(database('stripe', 'live'), 'order', stripe, waffo)).resolves.toEqual({ status: 'pending' });
  expect(waffo).not.toHaveBeenCalled(); expect(providers.waffo).not.toHaveBeenCalled();
});
it.each([['unknown', 'test'], ['waffo', 'prod']])('refuses unknown original scope %s/%s before provider access', async (channel, mode) => {
  await expect(dispatchOrderRefund(database(channel, mode), 'order', vi.fn(), vi.fn())).rejects.toThrow();
  expect(providers.stripe).not.toHaveBeenCalled(); expect(providers.waffo).not.toHaveBeenCalled();
});
