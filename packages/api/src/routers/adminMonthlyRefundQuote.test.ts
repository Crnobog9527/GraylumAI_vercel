/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const stripeClient = vi.hoisted(() => vi.fn());
vi.mock('../services/stripe', () => ({ getStripeClient: stripeClient }));
import { router } from '../trpc';
import { adminRefundProcedures } from './adminRefunds';
import { fixture, actorId, subjectId, request } from '../services/payments/__tests__/subscriptionRefundPreviewFixture';
const testRouter = router(adminRefundProcedures);
function setup(role = 'admin') {
  const f = fixture();
  f.tables.payment_orders[0].purchase_membership_level = 'pro';
  const sub = { id: 'sub_fixture', livemode: false, status: 'active', customer: 'cus_fixture',
    cancel_at_period_end: false, cancel_at: null, schedule: null, pending_update: null, pending_setup_intent: null,
    pause_collection: null, collection_method: 'charge_automatically', items: { has_more: false, data: [{
      current_period_end: Date.parse('2026-11-01T00:00:00Z') / 1000, quantity: 1,
      price: { recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 } },
    }] } };
  const stripe = { ...f.stripe, subscriptions: { ...f.stripe.subscriptions, retrieve: vi.fn(async () => sub) },
    invoiceItems: { list: vi.fn(async () => ({ data: [], has_more: false })) } };
  for (const method of [f.stripe.paymentIntents.retrieve, f.stripe.charges.retrieve]) {
    const original = method.getMockImplementation()!;
    method.mockImplementation(async () => ({ ...await original(), customer: 'cus_fixture' }) as never);
  }
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(async () =>
    ({ data: { localVersion: 'a'.repeat(32) }, error: null }));
  const db = { from: f.from, rpc };
  const profile = { id: actorId, role, status: 'active', is_deleted: 'false', membership_level: 'free', nickname: 'Fixture' };
  const scoped = { from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile }) }) };
  stripeClient.mockReturnValue(stripe);
  const caller = testRouter.createCaller({ headers: new Headers(),
    user: { id: actorId, app_metadata: {}, user_metadata: {} }, isEmailVerified: true, authProvider: 'email',
    supabase: scoped, supabaseAuth: scoped, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true,
  } as unknown as Parameters<typeof testRouter.createCaller>[0]);
  return { ...f, caller, rpc };
}
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z') }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('monthly quote reasons through real evidence/service and admin route', () => {
  it('preserves a successful read-only quote and repeats without approval or provider writes', async () => {
    const f = setup();
    const quote = await f.caller.quoteMonthlyRefund(request);
    expect(quote).toMatchObject({ executable: false, localVersion: 'a'.repeat(32),
      terms: { paidMinor: 6900, feeMinor: 414, netMinor: 6486 } });
    expect(await f.caller.quoteMonthlyRefund(request)).toEqual(quote);
    const concurrent = await Promise.all([f.caller.quoteMonthlyRefund(request), f.caller.quoteMonthlyRefund(request)]);
    expect(concurrent).toEqual([quote, quote]);
    for (const [name, args] of f.rpc.mock.calls) {
      expect(name).toBe('pay_common_monthly_refund_approve');
      expect(args).toMatchObject({ p_actor: actorId, p_order: request.orderId, p_local_version: null });
    }
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each([
    'PAY_REFUND_ADMIN_REQUIRED', 'PAY_MONTHLY_SCOPE_OR_STATE', 'PAY_REFUND_WINDOW', 'PAY_MONTHLY_CASH',
    'PAY_MONTHLY_AMOUNT', 'PAY_MONTHLY_HISTORY', 'PAY_REFUND_SETTLEMENT_UNRESOLVED',
    'PAY_REFUND_CONSUMPTION_OR_UNKNOWN', 'PAY_REFUND_GRANT_UNRESOLVED', 'PAY_REFUND_VERSION',
  ])('preserves exact SQL refusal %s without leaking diagnostics', async reason => {
    const f = setup();
    f.rpc.mockResolvedValue({ data: null, error: { message: reason, details: 'PRIVATE_DIAGNOSTIC', code: 'P0001' } });
    await expect(f.caller.quoteMonthlyRefund(request)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: reason });
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['window', 'consumed', 'not-first', 'renewal', 'ticket'] as const)('exposes actual %s rejection', async kind => {
    const f = setup();
    const expected = { window: 'PAY_REFUND_OUTSIDE_WINDOW', consumed: 'PAY_REFUND_CREDITS_CONSUMED',
      'not-first': 'PAY_REFUND_NOT_FIRST_PURCHASE', renewal: 'PAY_REFUND_RENEWAL', ticket: 'PAY_REFUND_TICKET_MISMATCH' };
    if (kind === 'window') f.tables.tickets[0].created_at = '2026-10-08T00:00:00.000001Z';
    if (kind === 'consumed') f.tables.credit_transactions.push({ ...f.tables.credit_transactions[0], id: 'spend',
      amount: -1, ledger_type: 'spend', counts_as_spend: true, source_order_id: null });
    if (kind === 'renewal') f.invoices[0].billing_reason = 'subscription_cycle';
    if (kind === 'ticket') f.tables.tickets[0].user_id = actorId;
    if (kind === 'not-first') {
      f.tables.payment_orders.push({ ...f.order, id: 'old-order' });
      f.tables.payment_provider_refs.push({ ...f.tables.payment_provider_refs[1], id: 'old-ref',
        order_id: 'old-order', external_id: 'old-invoice' });
      f.invoices.push({ ...f.invoices[0], id: 'old-invoice', status_transitions: { paid_at: Date.parse('2026-09-01') / 1000 } });
    }
    await expect(f.caller.quoteMonthlyRefund(request)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expected[kind] });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['database', 'provider'] as const)('sanitizes unknown %s errors', async kind => {
    const f = setup();
    if (kind === 'database') f.rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE_DIAGNOSTIC' } });
    else f.stripe.charges.retrieve.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
    const error = await f.caller.quoteMonthlyRefund(request).catch(error => error);
    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'PAY_REFUND_QUOTE_UNAVAILABLE' });
    expect(error.cause).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('retains the admin-only boundary', async () => {
    const f = setup('user');
    await expect(f.caller.quoteMonthlyRefund(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.reads).toEqual([]);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.tables.profiles[1].id).toBe(subjectId);
  });
});
