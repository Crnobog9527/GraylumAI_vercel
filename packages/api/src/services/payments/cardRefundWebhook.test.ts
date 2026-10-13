/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), find: vi.fn(), error: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./cardPaymentLookup', () => ({ findCardOrderForPayment: mocks.find }));
vi.mock('../../lib/logger', () => ({ logger: { error: mocks.error } }));
import { handleCardRefund } from './cardRefundWebhook';

const refund = (patch: Record<string, unknown> = {}) => ({ object: 'refund', id: 're_1', charge: 'ch_1', payment_intent: 'pi_1',
  status: 'succeeded', amount: 4900, currency: 'usd', created: 1792000000, metadata: {}, ...patch });
const match = { order: { id: 'order', item_type: 'membership_plan' }, paymentId: 'in_1', paymentIntentId: 'pi_1', kind: 'subscription_first' };

function fixture(refunds: ReturnType<typeof refund>[], result: Record<string, unknown> = { state: 'refunded', duplicate: false }) {
  const db = { rpc: vi.fn(async () => ({ error: null, data: result })), from: vi.fn((table: string) => {
    const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ error: null, data: table === 'payment_orders'
        ? { payment_channel: 'stripe', payment_method: 'card' } : null })) };
    return chain;
  }) };
  const stripe = { refunds: { retrieve: vi.fn(async () => refunds[0]), list: vi.fn(async () => ({ data: refunds })) },
    charges: { retrieve: vi.fn(async () => ({ payment_intent: 'pi_1' })) },
    paymentIntents: { retrieve: vi.fn(async (): Promise<Record<string, unknown>> => ({ metadata: {} })) },
    invoicePayments: { list: vi.fn(async () => ({ data: [] as unknown[] })) },
    invoices: { retrieve: vi.fn() }, subscriptions: { retrieve: vi.fn() } };
  const alert = vi.fn();
  const run = (input: { refundId?: string; chargeId?: string }) =>
    handleCardRefund(db as unknown as SupabaseClient, stripe as unknown as Stripe, input, alert);
  return { db, stripe, alert, run };
}

describe('PAY-STRIPE-MP external refunds of card orders', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.find.mockReset().mockResolvedValue(match); mocks.error.mockReset();
  });
  it('records each succeeded refund of the charge once, oldest first, against the paid period', async () => {
    const f = fixture([refund({ id: 're_2', created: 1792000100, amount: 100 }), refund({ id: 're_1' }),
      refund({ id: 're_pending', status: 'pending' })]);
    await expect(f.run({ chargeId: 'ch_1' })).resolves.toBe(true);
    expect(mocks.find).toHaveBeenCalledWith(f.db, f.stripe, { mode: 'test', merchant: 'fixture' }, { chargeId: 'ch_1', paymentIntentId: 'pi_1' });
    expect(f.db.rpc.mock.calls.map(call => (call as unknown as [string, { p_refund: string }])[1].p_refund)).toEqual(['re_1', 're_2']);
    expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_external_refund', { p_order: 'order', p_merchant: 'fixture',
      p_payment: 'in_1', p_refund: 're_1', p_amount: 4900, p_currency: 'usd', p_refunded_at: '2026-10-14T17:46:40.000Z' });
    expect(f.alert).not.toHaveBeenCalled();
  });
  it('leaves refunds we initiated (approval flows) to the existing path', async () => {
    const f = fixture([refund({ metadata: { refundIntentId: 'intent', orderId: 'order' } })]);
    await expect(f.run({ refundId: 're_1' })).resolves.toBe(false);
    expect(f.db.rpc).not.toHaveBeenCalled();
  });
  it('alerts for a partial refund kept for review, and for a full refund whose subscription still renews', async () => {
    const partial = fixture([refund({ amount: 1000 })], { state: 'partial_review', duplicate: false });
    await partial.run({ refundId: 're_1' });
    expect(partial.alert).toHaveBeenCalledTimes(1);
    const renewing = fixture([refund()], { state: 'refunded', duplicate: false, renewing: true });
    await renewing.run({ refundId: 're_1' });
    expect(renewing.alert).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith('billing', 'stripe_mp_external_refund_still_renewing',
      expect.objectContaining({ action: '该订阅仍在续费，请确认是否需要停续费' }));
    const duplicate = fixture([refund()], { state: 'refunded', duplicate: true, renewing: true });
    await duplicate.run({ refundId: 're_1' });
    expect(duplicate.alert).not.toHaveBeenCalled();
  });
  it('retries while a card order has not recorded the refunded payment yet; other payments go to the legacy path', async () => {
    mocks.find.mockResolvedValue(null);
    const pending = fixture([refund()]);
    pending.stripe.paymentIntents.retrieve.mockResolvedValue({ metadata: { orderId: '00000000-0000-4000-8000-000000000001' } });
    await expect(pending.run({ refundId: 're_1' })).rejects.toThrow('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    expect(pending.db.rpc).not.toHaveBeenCalled();
    const legacy = fixture([refund()]);
    await expect(legacy.run({ refundId: 're_1' })).resolves.toBe(false);
  });
  it('refuses a refund object that does not match the event', async () => {
    const f = fixture([refund({ id: 're_other' })]);
    await expect(f.run({ refundId: 're_1' })).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
  });
});
