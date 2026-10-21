/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ observe: vi.fn(), recover: vi.fn(), invoice: vi.fn(), state: vi.fn(), refund: vi.fn(), payment: vi.fn() }));
vi.mock('./stripeTestClock', async original => ({ ...await original<Record<string, unknown>>(), observeStripeTestClock: mocks.observe }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
vi.mock('./cardSubscriptionWebhook', () => ({ handleCardSubscriptionInvoice: mocks.invoice, handleCardSubscriptionState: mocks.state }));
vi.mock('./cardRefundWebhook', () => ({ handleCardRefund: mocks.refund }));
vi.mock('./disputePayment', () => ({ readDisputePayment: mocks.payment }));
import { reconcileStripeTestClockSources } from './stripeTestClockReconciliation';
const env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', V3_RUNTIME_STAGING_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
  NEXT_PUBLIC_SUPABASE_URL: 'https://gvcpmcunmfrbxuwimxfa.supabase.co', V3_RUNTIME_STAGING_DATABASE_HOST: 'gvcpmcunmfrbxuwimxfa.supabase.co',
  V3_RUNTIME_STAGING_ENABLED: 'true', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001',
  STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'true' };
const scope = { merchant: 'acct_fixture', mode: 'test' as const }, source = { id: 'order', user_id: 'owner', fulfilled_at: null as string | null };
const NOW = Date.parse('2026-10-21T12:00:00Z');
const options = () => ({ deadline: NOW + 60_000, maxPages: 3 });
function fixture() {
  const sources = [{ ...source }];
  const known: { data: { order_id: string } | null; error: null } = { data: null, error: null };
  const from = vi.fn((table: string) => {
    const q = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), limit: vi.fn().mockImplementation(async () => ({
      data: table === 'payment_orders' ? sources : [{ external_id: 'cs_fixture' }], error: null })),
      maybeSingle: vi.fn(async () => known) };
    for (const k of ['select', 'eq', 'not'] as const) q[k].mockReturnValue(q);
    return q;
  });
  const session = { id: 'cs_fixture', object: 'checkout.session', status: 'complete', payment_status: 'paid', subscription: 'sub_fixture',
    livemode: false, metadata: { orderId: 'order', userId: 'owner' }, client_reference_id: 'owner', customer: 'cus_fixture',
    mode: 'subscription', managed_payments: { enabled: true } };
  const list = vi.fn().mockResolvedValue({ data: [
    { id: 'in_first', billing_reason: 'subscription_create' }, { id: 'in_renewal', billing_reason: 'subscription_cycle' }], has_more: false });
  const refunds = vi.fn().mockResolvedValue({ data: [], has_more: false });
  const stripe = { checkout: { sessions: { retrieve: vi.fn(async () => session) } }, invoices: { list }, refunds: { list: refunds } };
  const db = { from } as unknown as SupabaseClient;
  const run = (params = options()) => reconcileStripeTestClockSources(db, stripe as unknown as Stripe, scope, params);
  return { sources, known, from, list, refunds, stripe, db, session, run };
}
describe('test-clock sources use directed normal-handler reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.observe.mockResolvedValue({ customerId: 'cus_fixture', clockId: 'clock_fixture', asOf: '2026-12-21T12:00:00Z' });
    mocks.payment.mockResolvedValue({ chargeId: 'ch_fixture' });
    mocks.invoice.mockResolvedValue(true);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
  it.each(['environment', 'live'])('does no additional work on %s ordinary paths', async reason => {
    const f = fixture();
    if (reason === 'environment') vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'main');
    const result = await reconcileStripeTestClockSources(f.db, f.stripe as unknown as Stripe,
      reason === 'live' ? { ...scope, mode: 'live' } : scope, options());
    expect(result).toEqual({ checked: 0, repaired: 0, complete: true, findings: [] });
    expect(f.from).not.toHaveBeenCalled(); expect(mocks.observe).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });
  it.each([
    { livemode: true }, { customer: 'cus_other' }, { metadata: { orderId: 'other', userId: 'owner' } },
    { metadata: { orderId: 'order', userId: 'other' } }, { client_reference_id: 'other' },
    { object: 'payment_intent' }, { id: 'cs_other' }, { mode: 'payment' }, { managed_payments: { enabled: false } },
  ])('rejects an untrusted Checkout result before invoking any financial handler: %j', async patch => {
    const f = fixture(); Object.assign(f.session, patch);
    await expect(f.run()).resolves.toMatchObject({ repaired: 0, findings: [{ kind: 'repair_failed',
      code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT' }] });
    expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.invoice).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled(); expect(mocks.state).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });
  it('uses the frozen customer and subscription in provider enumeration and normal handlers only', async () => {
    const f = fixture(); await expect(f.run()).resolves.toEqual({ checked: 3, repaired: 1, complete: true, findings: [] });
    expect(f.list).toHaveBeenCalledWith({ customer: 'cus_fixture', subscription: 'sub_fixture', status: 'paid', limit: 100 });
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_fixture', undefined, undefined);
    expect(mocks.invoice).toHaveBeenCalledExactlyOnceWith(f.db, f.stripe, 'in_renewal', 'invoice.paid', undefined, undefined, undefined);
    expect(mocks.state).toHaveBeenCalledWith(f.db, f.stripe, 'sub_fixture');
    expect(mocks.invoice.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.recover.mock.invocationCallOrder[0]!);
  });
  it('does not re-fulfill an already fulfilled initial order while still reconciling its renewal and cancellation', async () => {
    const f = fixture(); f.sources[0]!.fulfilled_at = '2026-10-21T11:59:00Z';
    await expect(f.run()).resolves.toMatchObject({ repaired: 1, complete: true });
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.invoice).toHaveBeenCalledOnce(); expect(mocks.state).toHaveBeenCalledOnce();
  });
  it.each(['known-payment', 'unhandled'])('does not count %s as a new repair', async reason => {
    const f = fixture();
    if (reason === 'known-payment') f.known.data = { order_id: 'already-renewed' };
    else mocks.invoice.mockResolvedValue(false);
    await expect(f.run()).resolves.toMatchObject({ repaired: 0, complete: true });
    expect(mocks.invoice).toHaveBeenCalledOnce();
  });
  it('routes refunds through the existing authoritative refund handler', async () => {
    const f = fixture(); f.refunds.mockResolvedValue({ data: [{ id: 're_fixture' }], has_more: false });
    await f.run();
    expect(mocks.refund).toHaveBeenCalledTimes(2);
    expect(mocks.refund).toHaveBeenCalledWith(f.db, f.stripe, { chargeId: 'ch_fixture' }, undefined);
  });
  it('never applies simulated time to the real task deadline', async () => {
    const f = fixture();
    const expired = await f.run({ ...options(), deadline: NOW - 1 });
    expect(expired).toMatchObject({ checked: 0, repaired: 0, complete: false, findings: [{ code: 'TIME_BUDGET' }] });
    expect(mocks.observe).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
    await expect(f.run()).resolves.toMatchObject({ complete: true, repaired: 1 });
  });
  it('stops at the real deadline between invoices without acknowledging unprocessed work', async () => {
    const f = fixture();
    mocks.payment.mockImplementationOnce(async () => { vi.setSystemTime(NOW + 60_001); return { chargeId: 'ch_fixture' }; });
    await expect(f.run()).resolves.toMatchObject({ checked: 2, repaired: 0, complete: false, findings: [{ code: 'TIME_BUDGET' }] });
    expect(mocks.invoice).not.toHaveBeenCalled(); expect(mocks.state).not.toHaveBeenCalled();
  });
  it('continues provider pagination with the actual cursor and reports an incomplete scan at its page cap', async () => {
    const f = fixture();
    f.list.mockResolvedValue({ data: [{ id: 'in_page', billing_reason: 'subscription_cycle' }], has_more: true });
    await expect(f.run({ ...options(), maxPages: 2 })).resolves.toMatchObject({ complete: false,
      findings: [{ kind: 'scan_incomplete', orderId: source.id }] });
    expect(f.list).toHaveBeenLastCalledWith({ customer: 'cus_fixture', subscription: 'sub_fixture', status: 'paid', limit: 100,
      starting_after: 'in_page' });
  });
  it('does not call handlers when provider clock authority cannot be established', async () => {
    const f = fixture(); mocks.observe.mockRejectedValue(new Error('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'));
    await expect(f.run()).resolves.toMatchObject({ checked: 1, repaired: 0, findings: [{ kind: 'repair_failed', orderId: source.id,
      code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT' }] });
    expect(f.list).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('does not count provider/handler failures as repaired', async () => {
    const f = fixture(); mocks.invoice.mockRejectedValue(new Error('PAY_STRIPE_MP_RENEWAL_UNAVAILABLE'));
    await expect(f.run()).resolves.toMatchObject({ repaired: 0, findings: [{ kind: 'repair_failed', code: 'PAY_STRIPE_MP_RENEWAL_UNAVAILABLE' }] });
    expect(mocks.state).not.toHaveBeenCalled();
  });
  it('returns an incomplete result when local source enumeration exceeds its fixed cap', async () => {
    const f = fixture(); f.sources.push(...Array.from({ length: 100 }, () => source));
    await expect(f.run()).resolves.toMatchObject({ complete: false, findings: [{ code: 'PAY_STRIPE_TEST_CLOCK_SOURCE_LIMIT' }] });
    expect(mocks.observe).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });
});
