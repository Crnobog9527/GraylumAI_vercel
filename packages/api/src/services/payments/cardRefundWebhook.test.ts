/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), find: vi.fn(), error: vi.fn(), monthly: vi.fn(), ref: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./cardPaymentLookup', () => ({ findCardOrderForPayment: mocks.find }));
vi.mock('./stripeReferences', () => ({ findStripeReference: mocks.ref }));
vi.mock('../../lib/logger', () => ({ logger: { error: mocks.error } }));
vi.mock('./monthlyRefundWebhook', () => ({ reconcileMonthlyRefundForOrder: mocks.monthly }));
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
  const stripe = { refunds: { retrieve: vi.fn(async () => refunds[0]),
    list: vi.fn(async (): Promise<{ data: unknown[]; has_more: boolean }> => ({ data: refunds, has_more: false })) },
    charges: { retrieve: vi.fn(async () => ({ payment_intent: 'pi_1' })) },
    paymentIntents: { retrieve: vi.fn(async (): Promise<Record<string, unknown>> => ({ metadata: {} })) },
    invoicePayments: { list: vi.fn(async () => ({ data: [] as unknown[] })) },
    invoices: { retrieve: vi.fn() }, subscriptions: { retrieve: vi.fn() } };
  const alert = vi.fn();
  const run = (input: { refundId?: string; chargeId?: string }) =>
    handleCardRefund(db as unknown as SupabaseClient, stripe as unknown as Stripe, input, alert);
  return { db, stripe, alert, run };
}

describe('R7: external refunds of wallet one-time memberships (0298)', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'live', merchant: 'fixture' });
    mocks.find.mockReset(); mocks.error.mockReset(); mocks.monthly.mockReset().mockResolvedValue({ handled: false });
    mocks.ref.mockReset().mockResolvedValue({ order_id: 'order' });
  });
  it.each(['wechat_pay', 'alipay'])('leaves an ordinary %s pack refund on its existing path; only converts a dispute hold', async method => {
    mocks.find.mockResolvedValue({ order: { id: 'order', item_type: 'credit_package', payment_method: method },
      paymentId: 'pi_1', paymentIntentId: 'pi_1', kind: 'pack' });
    for (const held of [false, true]) {
      const f = fixture([refund()]);
      const chain = { select: () => chain, eq: () => chain,
        limit: async () => ({ data: held ? [{ id: 'dispute' }] : [], error: null }) };
      f.db.from.mockImplementation((() => chain) as never);
      expect(await f.run({ refundId: 're_1' })).toBe(held);
      if (held) expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_external_refund', expect.any(Object));
      else expect(f.db.rpc).not.toHaveBeenCalled();
    }
  });
  it('looks the order up with wallet memberships included and records the refund against it, in live mode', async () => {
    mocks.find.mockResolvedValue({ order: { id: 'order', item_type: 'membership_plan', payment_method: 'alipay' },
      paymentId: 'pi_1', paymentIntentId: 'pi_1', kind: 'wallet_membership' });
    const f = fixture([refund({ id: 're_dash', amount: 49600 })], { state: 'refunded', duplicate: false, renewing: false });
    await expect(f.run({ refundId: 're_dash' })).resolves.toBe(true);
    expect(mocks.find).toHaveBeenCalledWith(f.db, f.stripe, { mode: 'live', merchant: 'fixture' },
      expect.objectContaining({ paymentIntentId: 'pi_1' }), { includeWalletMembership: true, includeWalletPacks: true });
    expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_external_refund', expect.objectContaining({
      p_order: 'order', p_payment: 'pi_1', p_refund: 're_dash', p_amount: 49600 }));
    expect(f.alert).not.toHaveBeenCalled();
  });
});

describe('R7: a wallet membership refunded before its payment is recorded is retried (0298)', () => {
  it('retries until the payment exists instead of acknowledging the refund as unmatched', async () => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'live', merchant: 'fixture' });
    mocks.find.mockReset().mockResolvedValue(null); mocks.ref.mockReset().mockResolvedValue(undefined); mocks.error.mockReset();
    const f = fixture([refund({ amount: 49600 })]);
    f.stripe.paymentIntents.retrieve.mockResolvedValue({ metadata: { orderId: '00000000-0000-4000-8000-000000000001' } });
    const wallet = { payment_channel: 'stripe', payment_method: 'alipay', item_type: 'membership_plan' };
    f.db.from = vi.fn(() => { const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ error: null, data: wallet })) }; return chain; }) as never;
    await expect(f.run({ refundId: 're_1' })).rejects.toThrow('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    expect(f.db.rpc).not.toHaveBeenCalled(); expect(f.alert).not.toHaveBeenCalled();
    // A wallet credit pack is not settled here: it keeps going to the existing path.
    wallet.item_type = 'credit_package';
    await expect(f.run({ refundId: 're_1' })).resolves.toBe(true);
  });
});

describe('PAY-STRIPE-MP external refunds of card orders', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.find.mockReset().mockResolvedValue(match); mocks.error.mockReset();
    mocks.monthly.mockReset().mockResolvedValue({ handled: false });
    mocks.ref.mockReset().mockResolvedValue({ order_id: 'order' });
  });
  it('records our approved monthly refund of a card subscription through the monthly refund flow (step 4b-2)', async () => {
    const ours = refund({ id: 're_ours', amount: 5390, metadata: { orderId: 'order', refundIntentId: 'intent' } });
    mocks.monthly.mockResolvedValue({ handled: true, result: {} });
    const f = fixture([ours]);
    await expect(f.run({ refundId: 're_ours' })).resolves.toBe(true);
    expect(mocks.monthly).toHaveBeenCalledWith(f.db, 'order', 're_ours', f.stripe);
    expect(f.db.rpc).not.toHaveBeenCalled(); expect(f.alert).not.toHaveBeenCalled();
    // An external refund (Link, Dashboard) while our monthly refund is approved or running is persisted on that intent
    // as a conflict for review, never also booked as an external refund.
    // Several external refunds are kept as one aggregate read from the charge (refund id null), not one slot each.
    mocks.monthly.mockReset().mockImplementation(async (_db: unknown, _order: string, refundId: string | null) =>
      ({ handled: refundId === null }));
    const during = fixture([refund({ id: 're_link', amount: 1000 }), refund({ id: 're_dash', amount: 500, created: 1792000100 })]);
    await expect(during.run({ chargeId: 'ch_1' })).resolves.toBe(true);
    expect(mocks.monthly).toHaveBeenCalledTimes(1);
    expect(mocks.monthly).toHaveBeenCalledWith(during.db, 'order', null, during.stripe);
    // A failed, canceled or still pending external refund has not moved cash: the running refund is not frozen by it
    // (a pending one that later succeeds is recorded by its success event).
    mocks.monthly.mockClear();
    const failed = fixture([refund({ id: 're_failed', status: 'failed' }), refund({ id: 're_canceled', status: 'canceled' }),
      refund({ id: 're_pending', status: 'pending', created: 1792000200 }), refund({ id: 're_action', status: 'requires_action' })]);
    await failed.run({ chargeId: 'ch_1' });
    expect(mocks.monthly).not.toHaveBeenCalledWith(failed.db, 'order', null, failed.stripe);
    expect(during.db.rpc).not.toHaveBeenCalled();
    expect(during.alert).toHaveBeenCalledTimes(1);
    // A refund of ours naming another order is a conflict, never recorded.
    const other = fixture([refund({ id: 're_ours', metadata: { orderId: 'another', refundIntentId: 'intent' } })]);
    await expect(other.run({ refundId: 're_ours' })).rejects.toThrow('PAYMENT_EVIDENCE_CONFLICT');
  });
  it('routes an external refund by what it matches: a card order with a monthly refund goes to that flow, a payment no '
    + 'local order references is alerted and acknowledged', async () => {
    // Matches a card order whose monthly refund is running: kept on that refund as a conflict (no external booking).
    mocks.monthly.mockResolvedValue({ handled: true, result: {} });
    const owned = fixture([refund({ id: 're_link', amount: 1000 })]);
    await expect(owned.run({ refundId: 're_link' })).resolves.toBe(true);
    expect(mocks.monthly).toHaveBeenCalledWith(owned.db, 'order', null, owned.stripe);
    expect(owned.db.rpc).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('billing', 'stripe_mp_external_refund_during_monthly_refund', expect.anything());
    // Matches no card order and no local order references the payment: alerted for review and acknowledged.
    mocks.monthly.mockReset().mockResolvedValue({ handled: false }); mocks.error.mockReset();
    mocks.find.mockResolvedValue(null); mocks.ref.mockResolvedValue(undefined);
    const unmatched = fixture([refund({ id: 're_offsite' })]);
    await expect(unmatched.run({ refundId: 're_offsite' })).resolves.toBe(true);
    expect(mocks.monthly).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('billing', 'stripe_mp_refund_unmatched', expect.objectContaining({ refundIds: ['re_offsite'] }));
    expect(unmatched.alert).toHaveBeenCalledTimes(1);
    expect(unmatched.db.rpc).not.toHaveBeenCalled();
  });
  it('records each succeeded refund of the charge once, oldest first, against the paid period', async () => {
    const f = fixture([refund({ id: 're_2', created: 1792000100, amount: 100 }), refund({ id: 're_1' }),
      refund({ id: 're_pending', status: 'pending' })]);
    await expect(f.run({ chargeId: 'ch_1' })).resolves.toBe(true);
    expect(mocks.find).toHaveBeenCalledWith(f.db, f.stripe, { mode: 'test', merchant: 'fixture' },
      { chargeId: 'ch_1', paymentIntentId: 'pi_1' }, { includeWalletMembership: true, includeWalletPacks: true });
    expect(f.db.rpc.mock.calls.map(call => (call as unknown as [string, { p_refund: string }])[1].p_refund)).toEqual(['re_1', 're_2']);
    expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_external_refund', { p_order: 'order', p_merchant: 'fixture',
      p_payment: 'in_1', p_refund: 're_1', p_amount: 4900, p_currency: 'usd', p_refunded_at: '2026-10-14T17:46:40.000Z' });
    expect(f.alert).not.toHaveBeenCalled();
  });
  it('never treats our own approved refund that kept the 6% fee (a partial refund at Stripe) as an external refund', async () => {
    // 4b-1: pre-tax 940 - fee 56 + tax 188 = 1072 of a 1128 charge, created with our refundIntentId.
    for (const input of [{ refundId: 're_ours' }, { chargeId: 'ch_1' }]) {
      const f = fixture([refund({ id: 're_ours', amount: 1072, metadata: { orderId: 'order', refundIntentId: 'intent' } })]);
      await expect(f.run(input)).resolves.toBe(false);
      expect(f.db.rpc).not.toHaveBeenCalled();
      expect(f.alert).not.toHaveBeenCalled();
    }
  });
  it('leaves refunds we initiated (approval flows) to the existing path', async () => {
    const f = fixture([refund({ metadata: { refundIntentId: 'intent', orderId: 'order' } })]);
    await expect(f.run({ refundId: 're_1' })).resolves.toBe(false);
    expect(f.db.rpc).not.toHaveBeenCalled();
  });
  it('records the external refunds of a charge that also carries one of ours, and still hands ours to the existing path', async () => {
    const f = fixture([refund({ id: 're_ours', metadata: { refundIntentId: 'intent', orderId: 'order' } }),
      refund({ id: 're_link', created: 1792000100, amount: 1000 })]);
    await expect(f.run({ chargeId: 'ch_1' })).resolves.toBe(false);
    expect(f.db.rpc).toHaveBeenCalledTimes(1);
    expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_external_refund', expect.objectContaining({ p_refund: 're_link' }));
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
    const pack = fixture([refund()], { state: 'pack_review', duplicate: false, packageId: 'pkg', packCredits: 990, balance: 120 });
    await pack.run({ refundId: 're_1' });
    expect(pack.alert).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith('billing', 'stripe_mp_external_refund_pack',
      expect.objectContaining({ orderId: 'order', packageId: 'pkg', packCredits: 990, balance: 120 }));
    // A replay after a crash between recording and alerting alerts again from the persisted state.
    const replay = fixture([refund()], { state: 'pack_review', duplicate: true, packageId: 'pkg', packCredits: 990, balance: 120 });
    await replay.run({ refundId: 're_1' });
    expect(replay.alert).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenLastCalledWith('billing', 'stripe_mp_external_refund_pack', expect.objectContaining({
      dedupKey: 'stripe-mp-external-refund:pack_review:order:re_1', replay: true }));
    const settled = fixture([refund()], { state: 'refunded', duplicate: true, renewing: false });
    await settled.run({ refundId: 're_1' });
    expect(settled.alert).not.toHaveBeenCalled();
  });
  it('retries while a card order has not recorded the refunded payment yet; other payments go to the legacy path', async () => {
    mocks.find.mockResolvedValue(null);
    const pending = fixture([refund()]);
    pending.stripe.paymentIntents.retrieve.mockResolvedValue({ metadata: { orderId: '00000000-0000-4000-8000-000000000001' } });
    await expect(pending.run({ refundId: 're_1' })).rejects.toThrow('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    expect(pending.db.rpc).not.toHaveBeenCalled();
    // A payment some local order references (legacy, wallet): left to the existing path.
    mocks.ref.mockResolvedValue({ order_id: 'legacy-order' });
    const legacy = fixture([refund()]);
    await expect(legacy.run({ refundId: 're_1' })).resolves.toBe(false);
    expect(legacy.alert).not.toHaveBeenCalled();
  });
  it('alerts and acknowledges a succeeded external refund of a payment no local order references at all', async () => {
    mocks.find.mockResolvedValue(null); mocks.ref.mockResolvedValue(undefined);
    const f = fixture([refund()]);
    f.stripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: 'in_offsite' }] });
    await expect(f.run({ refundId: 're_1' })).resolves.toBe(true);
    expect(mocks.ref).toHaveBeenCalledWith(f.db, 'payment', 'pi_1', { mode: 'test', merchant: 'fixture' });
    expect(mocks.ref).toHaveBeenCalledWith(f.db, 'invoice', 'in_offsite', { mode: 'test', merchant: 'fixture' });
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith('billing', 'stripe_mp_refund_unmatched', expect.objectContaining({ refundIds: ['re_1'] }));
    expect(f.db.rpc).not.toHaveBeenCalled();
    // Not succeeded (nothing refunded yet), or a refund of ours: no alert, left to the existing path.
    const pending = fixture([refund({ status: 'pending' })]);
    await expect(pending.run({ refundId: 're_1' })).resolves.toBe(false);
    expect(pending.alert).not.toHaveBeenCalled();
  });
  it('reads every page of a charge\'s refunds and fails rather than acknowledging an incomplete list', async () => {
    const f = fixture([]);
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [refund({ id: 're_a' })], has_more: true })
      .mockResolvedValueOnce({ data: [refund({ id: 're_b', created: 1792000100 })], has_more: false });
    await expect(f.run({ chargeId: 'ch_1' })).resolves.toBe(true);
    expect(f.stripe.refunds.list).toHaveBeenLastCalledWith({ charge: 'ch_1', limit: 100, starting_after: 're_a' });
    expect(f.db.rpc).toHaveBeenCalledTimes(2);
    const endless = fixture([]);
    endless.stripe.refunds.list.mockResolvedValue({ data: [refund()], has_more: true });
    await expect(endless.run({ chargeId: 'ch_1' })).rejects.toThrow('PAY_STRIPE_MP_REFUND_LIST_INCOMPLETE');
    expect(endless.db.rpc).not.toHaveBeenCalled();
  });
  it('refuses a refund object that does not match the event', async () => {
    const f = fixture([refund({ id: 're_other' })]);
    await expect(f.run({ refundId: 're_1' })).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
  });
});
