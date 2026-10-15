/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimedFixture, now } from './__tests__/monthlyRefundExecutionFixture';
const mocks = vi.hoisted(() => ({ read: vi.fn(), scope: vi.fn() }));
vi.mock('./monthlyRefundProvider', async importActual => ({
  ...await importActual<typeof import('./monthlyRefundProvider')>(), readMonthlyProvider: mocks.read }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
import { executeMonthlyRefund, type MonthlyDb } from './monthlyRefundService';
import type { MonthlyStripe } from './monthlyRefundProvider';

beforeEach(() => vi.useFakeTimers({ now: new Date(now) }));
afterEach(() => vi.useRealTimers());

/** PAY-STRIPE-MP step 4b-2: the real execution loop for a claimed card intent with tax, against a stand-in database
 * that applies each persisted stage, and Stripe as the original channel. */
describe('executing an approved card subscription refund with tax', () => {
  it('stops renewal, refunds pre-tax less fee plus the tax at Stripe, records it, then cancels marked as ours', async () => {
    const f = claimedFixture(1380);
    const terms = { ...f.intent.terms, merchant: 'merchant-fixture' };
    let intent: Record<string, unknown> = { ...f.intent, terms, kind: 'monthly_first_purchase', approvedBy: 'admin',
      status: 'review_required', hold: 'held', revision: 1, localVersion: 'local' };
    const cash: { refund: Record<string, unknown> | null; canceled: boolean; stopping: boolean } = { refund: null, canceled: false, stopping: false };
    mocks.scope.mockResolvedValue({ mode: 'test', merchant: 'merchant-fixture' });
    mocks.read.mockImplementation(async () => ({ checkedAt: new Date().toISOString(), merchant: 'merchant-fixture', mode: 'test',
      subscription: { id: terms.providerSubscriptionId, status: cash.canceled ? 'canceled' : 'active', periodEnd: terms.periodEnd,
        cancelAtPeriodEnd: cash.stopping, renewalOwnership: cash.stopping ? 'intent' : 'original', preflight: 'clear' },
      refunds: { complete: true, rows: cash.refund ? [cash.refund] : [] } }));
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pay_common_monthly_refund_start') {
        const started = { ...(intent.started as object), [args.p_stage as string]: new Date().toISOString() };
        intent = { ...intent, started, revision: (intent.revision as number) + 1 };
      } else if (name === 'pay_common_monthly_refund_result') {
        const refund = args.p_refund as { id: string; status: string };
        intent = { ...intent, recordedRefund: { id: refund.id, status: refund.status } };
      } else if (name === 'pay_common_monthly_refund_finish') {
        intent = { ...intent, status: 'succeeded', hold: 'terminated' };
        return { data: intent, error: null };
      }
      return { data: { ok: true }, error: null };
    });
    const db = { rpc, from: vi.fn(() => {
      const chain = { select: () => chain, eq: () => chain, in: () => chain,
        single: async () => ({ data: { refund_approval: intent }, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, data: [
          { id: 'admin', role: 'admin', status: 'active', is_deleted: 'false' },
          { id: terms.userId, role: 'user', status: 'active', is_deleted: 'false' }] }).then(resolve) };
      return chain;
    }) } as unknown as MonthlyDb;
    const create = vi.fn(async (params: { amount: number; metadata: Record<string, string> }) => {
      cash.refund = { id: 're_card', intentId: f.intent.id, orderId: terms.orderId, chargeId: terms.chargeId,
        paymentIntentId: terms.paymentIntentId, currency: 'usd', amount: params.amount, merchant: 'merchant-fixture', mode: 'test',
        status: 'succeeded' };
      return { object: 'refund', id: 're_card', amount: params.amount, currency: 'usd', charge: terms.chargeId,
        payment_intent: terms.paymentIntentId, status: 'succeeded', metadata: params.metadata };
    });
    const update = vi.fn(async (_id: string, params: { cancel_at_period_end?: boolean }) => { cash.stopping = Boolean(params.cancel_at_period_end); });
    const cancel = vi.fn(async () => { cash.canceled = true; });
    const stripe = { refunds: { create }, subscriptions: { update, cancel } } as unknown as MonthlyStripe;

    const done = await executeMonthlyRefund(db, stripe, 'admin', terms.orderId, f.intent.id);
    expect(done).toMatchObject({ status: 'succeeded' });
    expect(update).toHaveBeenCalledWith(terms.providerSubscriptionId, expect.objectContaining({ cancel_at_period_end: true,
      cancellation_details: { comment: 'graylum_initiated' } }), expect.anything());
    // 69.00 pre-tax - 4.14 fee + 13.80 tax.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ charge: terms.chargeId, amount: 7866,
      metadata: { orderId: terms.orderId, refundIntentId: f.intent.id } }), expect.anything());
    expect(cancel).toHaveBeenCalledWith(terms.providerSubscriptionId, expect.objectContaining({
      cancellation_details: { comment: 'graylum_initiated' } }));
    expect(rpc.mock.calls.map(call => call[0]).filter(name => name === 'pay_common_monthly_refund_result')).not.toHaveLength(0);
  });
});
