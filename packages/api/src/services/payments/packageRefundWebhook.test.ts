/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const state = vi.hoisted(() => ({ retrieve: vi.fn(), record: vi.fn() }));
vi.mock('../stripe', () => ({ getStripeClient: () => ({ refunds: { retrieve: state.retrieve } }) }));
vi.mock('./packageRefund', () => ({ recordPackageRefund: state.record }));
import { reconcileApprovedPackageRefundWebhook } from './packageRefundWebhook';
beforeEach(() => vi.clearAllMocks());
const db = {} as SupabaseClient;
const refund = { id: 're_fixture', metadata: { refundIntentId: 'intent', orderId: 'order' }, status: 'pending' } as unknown as Stripe.Refund;
describe('existing webhook entry for approved package refund', () => {
  it.each(['refund', 'charge'])('re-reads authoritative result for %s before local completion', async type => {
    const verified = { ...refund, status: 'succeeded' };
    state.retrieve.mockResolvedValue(verified);state.record.mockResolvedValue({ status: 'succeeded' });
    const input = type === 'refund' ? { refund } : { charge: { refunds: { data: [refund] } } as Stripe.Charge };
    expect(await reconcileApprovedPackageRefundWebhook(db, input)).toEqual({ handled: true, result: { status: 'succeeded' } });
    expect(state.record).toHaveBeenCalledWith(db, expect.anything(), 'order', verified);
  });
  it('unbound events keep the existing reconciliation path', async () => {
    expect(await reconcileApprovedPackageRefundWebhook(db, { refund: { metadata: {} } as Stripe.Refund })).toEqual({ handled: false });
    expect(state.record).not.toHaveBeenCalled();
  });
  it('failed provider lookup never falls through to legacy clawback', async () => {
    state.retrieve.mockRejectedValue(new Error('lookup failed'));
    await expect(reconcileApprovedPackageRefundWebhook(db, { refund })).rejects.toThrow('lookup failed');
    expect(state.record).not.toHaveBeenCalled();
  });
});
