/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const state = vi.hoisted(() => ({ retrieve: vi.fn(), record: vi.fn(), monthly: vi.fn(), kind: '' }));
vi.mock('../stripe', () => ({ getStripeClient: () => ({ refunds: { retrieve: state.retrieve } }) }));
vi.mock('./packageRefund', () => ({ recordPackageRefund: state.record }));
vi.mock('./monthlyRefundService', () => ({ recordMonthlyRefund: state.monthly }));
import { reconcileApprovedPackageRefundWebhook } from './packageRefundWebhook';
beforeEach(() => { vi.clearAllMocks(); state.kind = ''; });
const query = { select: () => query, eq: () => query,
  single: async () => ({ data: { refund_approval: { kind: state.kind } }, error: null }) };
const db = { from: () => query } as unknown as SupabaseClient;
const refund = { id: 're_fixture', metadata: { refundIntentId: 'intent', orderId: 'order' }, status: 'pending' } as unknown as Stripe.Refund;
describe('existing webhook entry for approved package refund', () => {
  it.each(['refund', 'charge'])('re-reads authoritative result for %s before local completion', async type => {
    const verified = { ...refund, status: 'succeeded' };
    state.retrieve.mockResolvedValue(verified);state.record.mockResolvedValue({ status: 'succeeded' });
    const input = type === 'refund' ? { refund } : { charge: { refunds: { data: [refund] } } as Stripe.Charge };
    expect(await reconcileApprovedPackageRefundWebhook(db, input)).toEqual({ handled: true, result: { status: 'succeeded' } });
    expect(state.record).toHaveBeenCalledWith(db, expect.anything(), 'order', verified);
  });
  it('routes monthly evidence to its own transaction without package clawback', async () => {
    state.kind = 'monthly_first_purchase'; state.retrieve.mockResolvedValue(refund);
    state.monthly.mockResolvedValue({ status: 'review_required' });
    expect(await reconcileApprovedPackageRefundWebhook(db, { refund })).toMatchObject({ handled: true });
    expect(state.monthly).toHaveBeenCalledWith(db, expect.anything(), 'order', refund);
    expect(state.record).not.toHaveBeenCalled();
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
