/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const recover = vi.hoisted(() => vi.fn());
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: recover }));
import { fulfillRecoveredPaidCheckout } from './methodCheckoutSync';

const session = { id: 'cs_paid', mode: 'subscription', status: 'complete', payment_status: 'paid' } as Stripe.Checkout.Session;
function db(order: unknown) {
  const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => ({ data: order, error: null })) };
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

describe('PAY-STRIPE-MP paid session recovered by a new checkout request', () => {
  it('fulfills a card or wallet order through the method recovery, never the legacy path', async () => {
    recover.mockReset().mockResolvedValue({ orderId: 'order-card' });
    const legacy = vi.fn();
    await fulfillRecoveredPaidCheckout(db({ status: 'completed', fulfilled_at: '2026-10-13T00:00:00.000Z' }), {} as Stripe,
      session, 'user-1', legacy);
    expect(recover).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'cs_paid');
    expect(legacy).not.toHaveBeenCalled();
  });
  it('keeps the legacy fulfillment for legacy orders', async () => {
    recover.mockReset().mockResolvedValue(null);
    const legacy = vi.fn();
    await fulfillRecoveredPaidCheckout(db(null), {} as Stripe, session, 'user-1', legacy);
    expect(legacy).toHaveBeenCalledTimes(1);
  });
  it('fails without falling back to the legacy path when the method recovery fails', async () => {
    recover.mockReset().mockRejectedValue(new Error('PAY_WAFFO_PAYMENT_CONFLICT'));
    const legacy = vi.fn();
    await expect(fulfillRecoveredPaidCheckout(db(null), {} as Stripe, session, 'user-1', legacy)).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    expect(legacy).not.toHaveBeenCalled();
  });
});
