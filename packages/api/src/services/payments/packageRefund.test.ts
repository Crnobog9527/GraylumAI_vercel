/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { executePackageRefund, readPackageRefundStatus, readPackageRefundCash, reconcilePackageRefund, type RefundStripe } from './packageRefund';

const orderId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const approval = { id: intentId, orderId, ticketId: orderId, status: 'review_required',
    netMinor: 9400, currency: 'usd', idempotencyKey: 'pay-common:refund:' + intentId,
    claimedAt: new Date().toISOString(), cash: { chargeId: 'ch_fixture', paymentIntentId: 'pi_fixture' } };
  const order = { id: orderId, user_id: orderId, payment_channel: 'stripe', payment_mode: 'test',
    merchant_namespace: 'acct_fixture', amount_total: 10000, currency: 'usd', refund_approval: approval };
  const refund = { id: 're_fixture', amount: 9400, currency: 'usd', status: 'succeeded',
    charge: 'ch_fixture', payment_intent: 'pi_fixture', metadata: { orderId, refundIntentId: intentId } };
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    return { data: name.endsWith('_claim') ? approval : { status: 'succeeded' }, error: null };
  });
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query,
      single: async () => ({ data: order, error: null }),
      limit: async () => ({ data: table === 'payment_provider_refs' ? [{ external_id: 'pi_fixture' }] : [], error: null }) };
    return query;
  });
  const stripe = {
    accounts: { retrieveCurrent: vi.fn(async () => ({ id: 'acct_fixture' })) },
    balance: { retrieve: vi.fn(async () => ({ livemode: false })) },
    paymentIntents: { retrieve: vi.fn(async () => ({ id: 'pi_fixture', livemode: false, status: 'succeeded',
      amount_received: 10000, currency: 'usd', latest_charge: 'ch_fixture' })) },
    charges: { retrieve: vi.fn(async () => ({ id: 'ch_fixture', livemode: false, paid: true, captured: true,
      payment_intent: 'pi_fixture', amount: 10000, amount_captured: 10000, amount_refunded: 0,
      currency: 'usd', disputed: false, balance_transaction: { created: 1790800000 } })) },
    refunds: {
      list: vi.fn(async (): Promise<{ data: typeof refund[]; has_more: boolean }> => ({ data: [], has_more: false })),
      create: vi.fn(async () => { calls.push('stripe.create'); return refund; }),
    },
  };
  return { approval, order, stripe, rpc, refund, calls,
    db: { from, rpc } as unknown as SupabaseClient, provider: stripe as unknown as RefundStripe };
}
describe('package refund dispatch boundary', () => {
  it('commits stable identity before sending exact net cash', async () => {
    const f = fixture();
    expect(await executePackageRefund(f.db, f.provider, orderId, { orderId, intentId })).toEqual({ status: 'succeeded' });
    expect(f.calls).toEqual(['pay_common_package_refund_claim', 'stripe.create', 'pay_common_package_refund_result']);
    expect(f.stripe.refunds.create).toHaveBeenCalledWith({ charge: 'ch_fixture', amount: 9400,
      metadata: { orderId, refundIntentId: intentId } }, { idempotencyKey: f.approval.idempotencyKey });
  });
  it.each(['live', 'waffo', 'wrongMerchant', 'dispute', 'unmapped', 'incompleteCapture'])('refuses %s with zero cash calls', async kind => {
    const f = fixture();
    if (kind === 'live') f.order.payment_mode = 'live';
    if (kind === 'waffo') f.order.payment_channel = 'waffo';
    if (kind === 'wrongMerchant') f.order.merchant_namespace = 'acct_other';
    if (kind === 'dispute') {
      const charge = await f.stripe.charges.retrieve(); charge.disputed = true;
      f.stripe.charges.retrieve.mockResolvedValue(charge);
    }
    if (kind === 'incompleteCapture') {
      const charge = await f.stripe.charges.retrieve(); charge.amount_captured = 10;
      f.stripe.charges.retrieve.mockResolvedValue(charge);
    }
    if (kind === 'unmapped') {
      const payment = await f.stripe.paymentIntents.retrieve(); payment.id = 'pi_other';
      f.stripe.paymentIntents.retrieve.mockResolvedValue(payment);
    }
    await expect(executePackageRefund(f.db, f.provider, orderId, { orderId, intentId })).rejects.toThrow();
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('fails closed on claim rejection', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: null as never, error: { message: 'stale' } as never });
    await expect(executePackageRefund(f.db, f.provider, orderId, { orderId, intentId })).rejects.toThrow();
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('unknown result never creates a second identity or restores credits', async () => {
    const f = fixture(); f.stripe.refunds.create.mockRejectedValue(new Error('timeout'));
    expect(await executePackageRefund(f.db, f.provider, orderId, { orderId, intentId }))
      .toMatchObject({ status: 'review_required', intentId });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(await readPackageRefundStatus(f.db, orderId)).toMatchObject({ status: 'review_required', id: intentId });
  });
  it('cash success followed by local failure remains unresolved', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async name => name.endsWith('_claim')
      ? { data: f.approval, error: null } : { data: null as never, error: { message: 'db unavailable' } as never });
    expect(await executePackageRefund(f.db, f.provider, orderId, { orderId, intentId }))
      .toMatchObject({ status: 'review_required' });
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(await readPackageRefundStatus(f.db, orderId)).toMatchObject({ status: 'review_required', id: intentId });
  });
});
describe('original payment reconciliation', () => {
  it('finds the original refund before any send', async () => {
    const f = fixture(); f.stripe.refunds.list.mockResolvedValue({ data: [f.refund], has_more: false });
    await reconcilePackageRefund(f.db, f.provider, orderId, orderId);
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith('pay_common_package_refund_result', expect.objectContaining({ p_intent: intentId }));
  });
  it.each(['review_required', 'dispatching'])('retries %s only with the identical durable key after complete lookup', async status => {
    const f = fixture(); f.approval.status = status;
    await reconcilePackageRefund(f.db, f.provider, orderId, orderId);
    expect(f.stripe.refunds.list).toHaveBeenCalledTimes(2);
    expect(f.stripe.refunds.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: f.approval.idempotencyKey });
    expect(f.rpc).not.toHaveBeenCalledWith('pay_common_package_refund_claim', expect.anything());
  });
  it.each(['expired', 'pending', 'lookupFailed', 'duplicateMatch'])('does not retry %s', async kind => {
    const f = fixture();
    if (kind === 'expired') f.approval.claimedAt = '2020-01-01T00:00:00Z';
    if (kind === 'pending') f.approval.status = 'pending';
    if (kind === 'lookupFailed') f.stripe.refunds.list.mockRejectedValue(new Error('network'));
    if (kind === 'duplicateMatch') f.stripe.refunds.list.mockResolvedValue({ data: [f.refund, f.refund], has_more: false });
    try { await reconcilePackageRefund(f.db, f.provider, orderId, orderId); } catch { /* failed read is not permission */ }
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('pending prior cash prevents a fresh quote', async () => {
    const f = fixture(); f.stripe.refunds.list.mockResolvedValue({ data: [f.refund], has_more: false });
    await expect(readPackageRefundCash(f.db, f.provider, orderId)).rejects.toThrow('PAY_REFUND_PRIOR_REFUND_OR_DISPUTE');
  });
});
