/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), payment: vi.fn(), find: vi.fn(), read: vi.fn(), stop: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./disputePayment', () => ({ readDisputePayment: mocks.payment }));
vi.mock('./cardPaymentLookup', () => ({ findCardOrderForPayment: mocks.find }));
vi.mock('./cardSubscriptionStop', () => ({ readSubscription: mocks.read, stopUndeliveredSubscription: mocks.stop,
  stripeStopState: (s: { stopped: boolean; canceled: boolean }) => ({ stop: s.stopped, canceled: s.canceled }) }));
import { handlePaymentDispute, reconcilePaymentDisputes } from './disputes';
function fixture(overrides = {}) {
  const row = { id: 'internal-dispute', merchant_namespace: 'acct_test', mode: 'test', provider_dispute_id: 'du_test',
    order_id: 'order', subscription_id: 'local_sub', provider_subscription_id: 'sub_test', freeze_state: 'frozen',
    renewal_stop_state: 'pending', stop_attempts: 0, source_review_required: false, evidence_due_by: '2026-10-25T00:00:00Z',
    opened_at: new Date().toISOString(), closed_at: null, alerted_at: null, freeze_alerted_at: null, stop_alerted_at: null,
    unmatched_alerted_at: null, closed_alerted_at: null, ...overrides };
  const rpc = vi.fn(async (name: string) => {
    if (name === 'pay_dispute_receive') return { data: { ...row }, error: null };
    if (name === 'pay_dispute_stop_claim') return { data: row.stop_attempts++ < 3, error: null };
    if (name === 'pay_dispute_stop_confirm') row.renewal_stop_state = 'confirmed';
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { renewal_stop_state: row.renewal_stop_state }, error: null }) }) }),
    update: (values: object) => {
      let allowed: string[] | undefined;
      const query: Record<string, unknown> = {};
      query.eq = () => query;
      query.in = (_field: string, states: string[]) => { allowed = states;return query; };
      query.select = async () => {
        if (allowed && !allowed.includes(row.renewal_stop_state)) return { data: [], error: null };
        Object.assign(row, values);return { data: [{ id: row.id }], error: null };
      };
      query.then = (resolve: (value: unknown) => unknown) => {
        Object.assign(row, values);return Promise.resolve({ error: null }).then(resolve);
      };
      return query;
    },
  }));
  const db = { rpc, from } as unknown as SupabaseClient;
  const event = { id: 'evt_test', type: 'charge.dispute.created', created: 1792300000, livemode: false,
    data: { object: { object: 'dispute', id: 'du_test', charge: 'ch_test', payment_intent: null, livemode: false,
      created: 1792300000, amount: 1000, currency: 'usd', reason: 'fraudulent', status: 'needs_response',
      evidence_details: { due_by: 1792886400 }, balance_transactions: [] } } } as unknown as Stripe.Event;
  const alert = vi.fn();
  return { row, rpc, db, event, alert, run: () => handlePaymentDispute(db, {} as Stripe, event, alert) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ merchant: 'acct_test', mode: 'test' });
  mocks.payment.mockResolvedValue({ chargeId: 'ch_test', paymentIntentId: 'pi_test', invoiceId: 'in_test',
    subscriptionId: 'sub_test', paymentAt: '2026-10-18T01:00:00Z' });
  mocks.find.mockResolvedValue({ order: { id: 'order' } });
  mocks.read.mockResolvedValue({ stopped: true, canceled: false });
  mocks.stop.mockResolvedValue(undefined);
});
describe('Stripe dispute effects resume from committed financial state', () => {
  it('reuses the order lookup, records original payment time and resumes a persisted freeze on replay', async () => {
    const f = fixture(); await f.run(); await f.run();
    expect(mocks.find).toHaveBeenCalledWith(f.db, {}, { merchant: 'acct_test', mode: 'test' }, expect.anything(),
      { includeWalletMembership: true, includeWalletPacks: true });
    expect(f.rpc).toHaveBeenCalledWith('pay_dispute_receive', expect.objectContaining({ p_event: expect.objectContaining({
      paymentAt: '2026-10-18T01:00:00Z', id: 'evt_test' }) }));
    expect(f.rpc.mock.calls.filter(([name]) => name === 'pay_dispute_stop_confirm')).toHaveLength(1);
    expect(f.alert.mock.calls.filter(([notice]) => notice.code === 'PAY_DISPUTE_PAYMENT_FROZEN')).toHaveLength(1);
  });
  it('after an update times out, observes the actual stop before deciding whether to mutate again', async () => {
    const f = fixture(); let stopped = false;
    mocks.read.mockImplementation(async () => ({ stopped, canceled: false }));
    mocks.stop.mockImplementation(async () => { stopped = true; throw new Error('uncertain'); });
    await f.run(); expect(mocks.stop).toHaveBeenCalledTimes(1); expect(f.row.renewal_stop_state).toBe('confirmed');
  });
  it('caps mutations at three and persists manual attention without repeated alerts on delivery retry', async () => {
    const f = fixture(); mocks.read.mockResolvedValue({ stopped: false, canceled: false }); mocks.stop.mockRejectedValue(new Error('offline'));
    await f.run(); await f.run();
    expect(mocks.stop).toHaveBeenCalledTimes(3); expect(f.row.renewal_stop_state).toBe('manual');
    expect(f.alert.mock.calls.filter(([notice]) => notice.code === 'PAY_DISPUTE_STOP_MANUAL')).toHaveLength(1);
  });
  it('does not downgrade a stop confirmed by a concurrent delivery after an active provider read', async () => {
    const f = fixture();mocks.read.mockResolvedValue({ stopped: false, canceled: false });
    f.rpc.mockImplementation(async name => {
      if (name === 'pay_dispute_receive') return { data: { ...f.row }, error: null };
      if (name === 'pay_dispute_stop_claim') { f.row.renewal_stop_state = 'confirmed';return { data: false, error: null }; }
      return { data: null, error: null };
    });
    await f.run();expect(f.row.renewal_stop_state).toBe('confirmed');expect(mocks.stop).not.toHaveBeenCalled();
    expect(f.alert.mock.calls.filter(([notice]) => notice.code === 'PAY_DISPUTE_STOP_MANUAL')).toHaveLength(0);
  });
  it('unmatched payments are recorded and alerted, without canceling an unrelated provider subscription', async () => {
    const f = fixture({ order_id: null, subscription_id: null, freeze_state: 'pending',
      opened_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    mocks.find.mockResolvedValue(null); await f.run(); await f.run();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
    expect(f.alert.mock.calls.filter(([notice]) => notice.code === 'PAY_DISPUTE_UNMATCHED_24H')).toHaveLength(1);
  });
  it('acknowledges a verified charge-only dispute with an operational alert instead of retrying forever', async () => {
    const f = fixture(); mocks.payment.mockRejectedValueOnce(new Error('PAY_DISPUTE_PAYMENT_INTENT_MISSING'));
    await expect(f.run()).resolves.toBe(true);
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAY_DISPUTE_PAYMENT_INTENT_MISSING', disputeId: 'du_test' }));
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refunded or externally canceled payments are reported and already canceled subscriptions need no update', async () => {
    const f = fixture({ freeze_state: 'superseded' }); mocks.read.mockResolvedValue({ stopped: false, canceled: true });
    await f.run(); expect(mocks.stop).not.toHaveBeenCalled();
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAY_DISPUTE_REFUNDED_PAYMENT' }));
  });
  it('a confirmed off-site dispute records later events without re-alerting or touching subscriptions', async () => {
    const f = fixture({ freeze_state: 'external', order_id: null, subscription_id: null, renewal_stop_state: 'not_applicable',
      opened_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    mocks.find.mockResolvedValue(null);await f.run();await f.run();
    expect(mocks.read).not.toHaveBeenCalled();expect(mocks.stop).not.toHaveBeenCalled();expect(f.alert).not.toHaveBeenCalled();
  });
  it('database failure rejects the webhook so Stripe can retry', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000' } } as never);
    await expect(f.run()).rejects.toThrow('PAY_DISPUTE_RECORD_UNAVAILABLE'); expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('the daily backstop resumes a committed freeze whose process stopped before the Stripe mutation', async () => {
    const f = fixture(); let stopped = false;
    mocks.read.mockImplementation(async () => ({ stopped, canceled: false }));
    mocks.stop.mockImplementation(async () => { stopped = true; });
    const originalFrom = f.db.from.bind(f.db);
    let scans = 0;
    const query: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'gte']) query[name] = () => query;
    query.limit = async () => ({ data: scans++ === 0 ? [{ ...f.row }] : [], error: null });
    f.db.from = (() => ({ ...query, update: originalFrom('payment_disputes').update.bind(originalFrom('payment_disputes')) })) as never;
    expect(await reconcilePaymentDisputes(f.db, {} as Stripe, f.alert)).toEqual({ checked: 1, failed: 0, complete: true });
    expect(mocks.stop).toHaveBeenCalledTimes(1); expect(f.row.renewal_stop_state).toBe('confirmed');
    expect(mocks.stop).toHaveBeenCalledWith({}, 'sub_test', { timeout: 2000, maxNetworkRetries: 0 });
  });
  it('scans matched pending renewal stops before unmatched dispute history', async () => {
    const f = fixture();
    let stopped = false;
    mocks.read.mockImplementation(async () => ({ stopped, canceled: false }));
    mocks.stop.mockImplementation(async () => { stopped = true; });
    const groups: string[] = [];
    let kind = '';
    const makeQuery = () => {
      const query: Record<string, unknown> = {};
      for (const name of ['eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'gt', 'gte']) query[name] = (field: string, value: unknown) => {
        if (name === 'or' && field.includes('stop_attempts.lt.3')) kind = 'stops';
        if (name === 'eq' && field === 'renewal_stop_state' && value === 'manual') kind = 'manual-stop-alerts';
        if (name === 'is' && field === 'order_id') kind = 'unmatched';
        if (name === 'not' && field === 'renewal_stop_state') kind = 'matched-alerts';
        return query;
      };
      query.limit = async () => {
        groups.push(kind);
        return { data: groups.length === 1 ? [{ ...f.row }] : [], error: null };
      };
      return query;
    };
    f.db.from = (() => {
      const query = makeQuery();
      return { select: () => query, update: () => ({ eq: () => ({ in: () => ({ select: async () => ({ data: [{ id: f.row.id }], error: null }) }) }) }) };
    }) as never;
    await expect(reconcilePaymentDisputes(f.db, {} as Stripe, f.alert)).resolves.toEqual({ checked: 1, failed: 0, complete: true });
    expect(groups).toEqual(['stops', 'manual-stop-alerts', 'matched-alerts', 'unmatched']);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
  it('replays the stop alert for an exhausted manual row without another Stripe mutation', async () => {
    const f = fixture({ renewal_stop_state: 'manual', stop_attempts: 3, alerted_at: new Date().toISOString(),
      freeze_alerted_at: new Date().toISOString(), stop_alerted_at: null });
    mocks.read.mockResolvedValue({ stopped: false, canceled: false });
    const query: Record<string, unknown> = {};
    let kind = '';
    for (const name of ['eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'gt', 'gte']) query[name] = (field: string, value: unknown) => {
      if (name === 'eq' && field === 'renewal_stop_state' && value === 'manual') kind = 'manual-stop-alerts';
      if (name === 'not' && field === 'renewal_stop_state') kind = 'matched-alerts';
      if (name === 'is' && field === 'order_id') kind = 'unmatched';
      return query;
    };
    query.select = () => query;
    query.limit = async () => ({ data: kind === 'manual-stop-alerts' ? [{ ...f.row }] : [], error: null });
    f.db.from = (() => ({ ...query, update: () => ({ eq: () => ({ in: () => ({
      select: async () => ({ data: [{ id: f.row.id }], error: null }),
    }) }) }) })) as never;
    await expect(reconcilePaymentDisputes(f.db, {} as Stripe, f.alert)).resolves.toMatchObject({ checked: 1, failed: 1, complete: true });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAY_DISPUTE_STOP_MANUAL' }));
  });
});
