/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stopUndeliveredSubscription } from './cardSubscriptionStop';

const sub = (patch: Record<string, unknown> = {}) => ({ object: 'subscription', id: 'sub_gold', livemode: false, status: 'active',
  cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: 1794472954 }] }, ...patch });
function stripe(states: Array<Record<string, unknown>>) {
  const retrieve = vi.fn(async () => sub(states.shift() ?? {}));
  const update = vi.fn(async () => ({}));
  return { client: { subscriptions: { retrieve, update } } as unknown as Stripe, retrieve, update };
}

describe('stopping an undelivered card subscription (paid first period kept for review)', () => {
  it('stops renewal at Stripe marked as ours and confirms it', async () => {
    const s = stripe([{}, { cancel_at_period_end: true }]);
    await stopUndeliveredSubscription(s.client, 'sub_gold');
    expect(s.update).toHaveBeenCalledWith('sub_gold', { cancel_at_period_end: true,
      cancellation_details: { comment: 'graylum_initiated' } });
  });
  it('does nothing when already stopped or canceled, and throws when Stripe does not confirm', async () => {
    for (const state of [{ cancel_at_period_end: true }, { status: 'canceled' }]) {
      const s = stripe([state]);
      await stopUndeliveredSubscription(s.client, 'sub_gold');
      expect(s.update).not.toHaveBeenCalled();
    }
    await expect(stopUndeliveredSubscription(stripe([{}, {}]).client, 'sub_gold')).rejects.toThrow('PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED');
  });
});
