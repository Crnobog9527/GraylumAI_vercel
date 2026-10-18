/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), payment: vi.fn(), record: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./disputePayment', () => ({ readDisputePayment: mocks.payment }));
vi.mock('./cardRefundWebhook', () => ({ handleCardRefund: mocks.record }));
import { reconcileDisputeRenewalRefunds, refundDisputedRenewal } from './disputeRenewalRefund';
function fixture() {
  const intent = { status: 'dispatching', claimedAt: new Date().toISOString(), refundId: null as string | null,
    idempotencyKey: 'dispute:renewal-refund:order', paymentKey: 'acct_test:test:pi_test' };
  const charge = { id: 'ch_test', livemode: false, payment_intent: 'pi_test', paid: true, captured: true, disputed: false,
    amount_captured: 1200, currency: 'usd', refunded: false, amount_refunded: 0 };
  const refund = { object: 'refund', id: 're_test', charge: 'ch_test', payment_intent: 'pi_test', amount: 1200, currency: 'usd',
    status: 'succeeded', metadata: { orderId: 'order', disputeRenewalOrderId: 'order' } };
  let rows: typeof refund[] = [];
  const api = { charges: { retrieve: vi.fn(async () => charge) }, refunds: {
    list: vi.fn(async () => ({ has_more: false, data: rows })),
    create: vi.fn(async () => { rows = [refund]; return refund; }), retrieve: vi.fn(async () => refund) } };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'pay_dispute_refund_claim') return { data: { ...intent }, error: null };
    if (name === 'pay_dispute_refund_result') { intent.status = args.p_state as string; intent.refundId = args.p_refund as string; }
    return { data: null, error: null };
  });
  const alert = vi.fn(), db = { rpc } as unknown as SupabaseClient;
  return { intent, charge, refund, api, rpc, alert, setRows: (value: typeof rows) => { rows = value; },
    run: () => refundDisputedRenewal(db, api as unknown as Stripe, 'order', 'in_test', alert) };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.scope.mockResolvedValue({ merchant: 'acct_test', mode: 'test' });
  mocks.payment.mockResolvedValue({ paymentIntentId: 'pi_test', chargeId: 'ch_test' }); mocks.record.mockResolvedValue(true);
});
describe('full refund of a renewal withheld by an earlier disputed period', () => {
  it('scans blocked refunds before a persistent manual backlog', async () => {
    const statuses: string[][] = [];
    const calls: string[] = [];
    const db = {
      from: vi.fn((table: string) => {
        let state: string[] = [];
        const chain = {
          select: vi.fn(() => chain), eq: vi.fn(() => chain), order: vi.fn(() => chain),
          in: vi.fn((_column: string, values: string[]) => { state = values; statuses.push(values); return chain; }),
          gt: vi.fn(() => chain),
          limit: vi.fn(async () => {
            if (table === 'payment_provider_refs') return { error: null, data: [{ external_id: 'in_blocked' }] };
            return { error: null, data: state[0] === 'blocked' ? [{ id: 'blocked_order' }]
              : state[0] === 'manual' ? [{ id: 'manual_order' }] : [] };
          }),
        };
        return chain;
      }),
      rpc: vi.fn(async () => ({ error: null, data: { status: 'succeeded', claimedAt: '', refundId: null,
        idempotencyKey: 'key', paymentKey: 'acct_test:test:pi_test' } })),
    };
    let reads = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => reads++ === 0 ? -1 : 1);
    try {
      const result = await reconcileDisputeRenewalRefunds(db as unknown as SupabaseClient, {} as Stripe, undefined, 0);
      calls.push(...statuses.map(state => state[0]!));
      expect(result).toEqual({ checked: 1, failed: 0, complete: false });
      expect(calls).toEqual(['blocked', 'dispatching', 'pending', 'manual']);
      expect(db.rpc).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
  it('refunds the full charge including tax once, reads it back and records through the existing external-refund handler', async () => {
    const f = fixture(); expect(await f.run()).toBe('succeeded'); expect(await f.run()).toBe('succeeded');
    expect(f.api.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.api.refunds.create).toHaveBeenCalledWith({ charge: 'ch_test', amount: 1200,
      metadata: { orderId: 'order', disputeRenewalOrderId: 'order' } }, { idempotencyKey: f.intent.idempotencyKey });
    expect(f.api.refunds.retrieve).toHaveBeenCalledWith('re_test'); expect(mocks.record).toHaveBeenCalledTimes(1);
  });
  it('looks up the actual result after timeout and never issues a second refund', async () => {
    const f = fixture(); f.api.refunds.create.mockImplementation(async () => { f.setRows([f.refund]); throw new Error('timeout'); });
    expect(await f.run()).toBe('succeeded'); expect(f.api.refunds.list).toHaveBeenCalledTimes(2);
    expect(f.api.refunds.create).toHaveBeenCalledTimes(1);
  });
  it('unknown cash outcome goes to manual review and delivery retry cannot create another refund', async () => {
    const f = fixture(); f.api.refunds.create.mockRejectedValue(new Error('timeout'));
    expect(await f.run()).toBe('manual'); expect(await f.run()).toBe('manual');
    expect(f.api.refunds.create).toHaveBeenCalledTimes(1); expect(f.alert).toHaveBeenCalledTimes(1);
  });
  it('a pending refund is observed on the next delivery, never dispatched again', async () => {
    const f = fixture(); f.refund.status = 'pending'; f.setRows([f.refund]);
    expect(await f.run()).toBe('pending'); f.refund.status = 'succeeded'; expect(await f.run()).toBe('succeeded');
    expect(f.api.refunds.create).not.toHaveBeenCalled();
  });
  it.each(['failed', 'canceled'])('a confirmed %s refund is manual, with no automatic replacement', async state => {
    const f = fixture(); f.refund.status = state; f.setRows([f.refund]);
    expect(await f.run()).toBe('manual'); expect(f.api.refunds.create).not.toHaveBeenCalled();
  });
  it.each(['disputed', 'expired intent', 'partial external refund', 'receipt mismatch'])('refuses an unsafe %s', async kind => {
    const f = fixture();
    if (kind === 'disputed') f.charge.disputed = true;
    if (kind === 'expired intent') f.intent.claimedAt = new Date(Date.now() - 21 * 3600_000).toISOString();
    if (kind === 'partial external refund') f.setRows([{ ...f.refund, amount: 100, metadata: {} as typeof f.refund.metadata }]);
    if (kind === 'receipt mismatch') { f.refund.amount = 1100; f.setRows([f.refund]); }
    expect(await f.run()).toBe('manual'); expect(f.api.refunds.create).not.toHaveBeenCalled();
  });
});
