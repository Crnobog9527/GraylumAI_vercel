/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const resolveScope = vi.hoisted(() => vi.fn());
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: resolveScope }));
import { closeRefundedTestClockCheckout } from './stripeTestClockClose';

const env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', V3_RUNTIME_STAGING_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
  NEXT_PUBLIC_SUPABASE_URL: 'https://gvcpmcunmfrbxuwimxfa.supabase.co', V3_RUNTIME_STAGING_DATABASE_HOST: 'gvcpmcunmfrbxuwimxfa.supabase.co',
  V3_RUNTIME_STAGING_ENABLED: 'true', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001',
  STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'true' };
const ORDER = '00000000-0000-4000-8000-000000000001', USER = 'owner', CUSTOMER = 'cus_clockfixture';
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const PAID = 1792566000;
function fixture(tax = 0) {
  const gross = 2900 + tax;
  const order = { id: ORDER, user_id: USER, item_type: 'membership_plan', payment_channel: 'stripe',
    merchant_namespace: scope.merchant, payment_mode: 'test', payment_method: 'card' as const, stripe_managed_payments: true,
    purchase_membership_level: 'pro', billing_cycle: 'monthly', fulfilled_at: null as string | null, subscription_id: null as string | null,
    checkout_request: { providerRequest: { customer: CUSTOMER } }, purchase_snapshot: { version: 1, item_type: 'membership_plan',
      item_id: '00000000-0000-4000-8000-000000000002', item_updated_at: '2026-10-01T00:00:00Z', billing_cycle: 'monthly',
      currency: 'usd', unit: 'major', price: '29.00', discount: '0.00', tax_behavior: 'exclusive', credits: 3480, bonus_credits: 0 } };
  const session = { object: 'checkout.session', id: 'cs_fixture', livemode: false, client_reference_id: USER, customer: CUSTOMER,
    metadata: { orderId: ORDER, userId: USER }, mode: 'subscription', payment_status: 'paid', status: 'complete',
    managed_payments: { enabled: true }, payment_method_types: ['card', 'link'], amount_total: gross,
    total_details: { amount_tax: tax }, currency: 'usd', subscription: 'sub_fixture', invoice: 'in_fixture' };
  const subscription = { object: 'subscription', id: 'sub_fixture', status: 'canceled', livemode: false, customer: CUSTOMER,
    test_clock: 'clock_fixture', canceled_at: PAID + 60, metadata: { orderId: ORDER, userId: USER }, managed_payments: { enabled: true },
    items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] } };
  const invoice = { object: 'invoice', id: 'in_fixture', livemode: false, status: 'paid', billing_reason: 'subscription_create',
    customer: CUSTOMER, test_clock: 'clock_fixture', currency: 'usd', amount_due: gross, amount_paid: gross, total_taxes: tax ? [{ amount: tax }] : [],
    status_transitions: { paid_at: PAID }, parent: { subscription_details: { subscription: 'sub_fixture' } },
    lines: { has_more: false, data: [{ quantity: 1, pricing: { price_details: { price: 'price_pro' } }, period: { start: PAID, end: PAID + 31 * 86400 } }] } };
  const invoicePayment = { id: 'inpay_fixture', object: 'invoice_payment', invoice: 'in_fixture', status: 'paid', livemode: false,
    payment: { type: 'payment_intent', payment_intent: 'pi_fixture' }, amount_paid: gross, currency: 'usd' };
  const intent = { object: 'payment_intent', id: 'pi_fixture', livemode: false, status: 'succeeded', customer: CUSTOMER,
    latest_charge: 'ch_fixture', currency: 'usd', amount_received: gross };
  const charge = { object: 'charge', id: 'ch_fixture', livemode: false, status: 'succeeded', paid: true, captured: true, disputed: false,
    customer: CUSTOMER, payment_intent: 'pi_fixture', currency: 'usd', amount_captured: gross, amount_refunded: gross, refunded: true };
  const refund = { id: 're_fixture', object: 'refund', status: 'succeeded', charge: 'ch_fixture', payment_intent: 'pi_fixture',
    currency: 'usd', amount: gross, created: PAID + 120 };
  const refunds = { list: vi.fn().mockResolvedValue({ data: [refund], has_more: false }) };
  const rpc = vi.fn<(name: string, params?: unknown) => Promise<{ data: { state: string; orderId: string; credits: number; duplicate?: boolean } | null;
    error: { message: string } | null }>>().mockImplementation(async name => ({ data: name === 'pay_stripe_test_clock_close_refunded'
    ? { state: 'refunded', orderId: ORDER, credits: 0 } : null, error: null }));
  const stripe = { checkout: { sessions: { retrieve: vi.fn(async () => session) } },
    subscriptions: { retrieve: vi.fn(async () => subscription) }, invoices: { retrieve: vi.fn(async () => invoice) },
    invoicePayments: { list: vi.fn().mockResolvedValue({ data: [invoicePayment], has_more: false }) },
    paymentIntents: { retrieve: vi.fn(async () => intent) }, charges: { retrieve: vi.fn(async () => charge) }, refunds,
    customers: { retrieve: vi.fn(async () => ({ id: CUSTOMER, object: 'customer', livemode: false,
      test_clock: 'clock_fixture', metadata: { graylum_user_id: USER } })) },
    testHelpers: { testClocks: { retrieve: vi.fn(async () => ({ id: 'clock_fixture', object: 'test_helpers.test_clock',
      livemode: false, status: 'ready', frozen_time: PAID + 180 })) } } };
  const persisted: { data: Record<string, unknown> | null } = { data: null };
  const from = vi.fn(() => {
    const q = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: persisted.data, error: null })) };
    q.select.mockReturnValue(q); q.eq.mockReturnValue(q); return q;
  });
  const db = { rpc, from } as unknown as SupabaseClient;
  const close = () => closeRefundedTestClockCheckout(db, stripe as unknown as Stripe, scope, order, 'cs_fixture', 'price_pro');
  return { order, session, subscription, invoice, invoicePayment, intent, charge, refund, refunds, rpc, stripe, db, persisted, from, close };
}
describe('unfulfilled first payment closes only from authoritative full-refund evidence', () => {
  beforeEach(() => { resolveScope.mockReset().mockResolvedValue(scope); for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); });
  afterEach(() => vi.unstubAllEnvs());
  it.each([0, 580])('closes the original $29 plus %s tax without calling any grant or fulfillment RPC', async tax => {
    const f = fixture(tax);
    await expect(f.close()).resolves.toBe(true);
    expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['pay_stripe_test_clock_observe', 'pay_stripe_test_clock_close_refunded']);
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_test_clock_close_refunded', { p_facts: {
      order: ORDER, checkout: 'cs_fixture', customer: CUSTOMER, clock: 'clock_fixture', merchant: scope.merchant,
      invoice: 'in_fixture', paymentIntent: 'pi_fixture', charge: 'ch_fixture', subscription: 'sub_fixture',
      paidMinor: 2900 + tax, taxMinor: tax, currency: 'usd', paidAt: new Date(PAID * 1000).toISOString(),
      canceledAt: new Date((PAID + 60) * 1000).toISOString(), refunds: [{ id: 're_fixture', amount: 2900 + tax,
        createdAt: new Date((PAID + 120) * 1000).toISOString() }] } });
  });
  it.each(['environment', 'live', 'customer-missing', 'fulfilled', 'mapped-subscription'])(
    'leaves the old path untouched and makes no provider/database calls when %s', async reason => {
      const f = fixture();
      if (reason === 'environment') vi.stubEnv('VERCEL_ENV', 'preview');
      if (reason === 'live') f.order.payment_mode = 'live';
      if (reason === 'customer-missing') f.order.checkout_request.providerRequest.customer = '';
      if (reason === 'fulfilled') f.order.fulfilled_at = '2026-10-21T12:00:00Z';
      if (reason === 'mapped-subscription') f.order.subscription_id = 'local-subscription';
      await expect(f.close()).resolves.toBe(false);
      expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
    });
  it.each(['open', 'expired', 'unpaid', 'active-subscription'])('does not misclassify %s as a refunded canceled first payment', async reason => {
    const f = fixture();
    if (reason === 'open' || reason === 'expired') f.session.status = reason;
    if (reason === 'unpaid') f.session.payment_status = 'unpaid';
    if (reason === 'active-subscription') f.subscription.status = 'active';
    await expect(f.close()).resolves.toBe(false); expect(f.rpc).not.toHaveBeenCalled();
  });
  const corruptions: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['session owner', f => { f.session.metadata.userId = 'other'; }],
    ['session customer vs frozen customer', f => { f.session.customer = 'cus_other'; }],
    ['session mode', f => { f.session.livemode = true; }],
    ['subscription owner', f => { f.subscription.metadata.orderId = 'another'; }],
    ['subscription customer', f => { f.subscription.customer = 'cus_other'; }],
    ['subscription mode', f => { f.subscription.livemode = true; }],
    ['invoice customer', f => { f.invoice.customer = 'cus_other'; }],
    ['invoice mode', f => { f.invoice.livemode = true; }],
    ['invoice not first invoice', f => { f.invoice.billing_reason = 'subscription_cycle'; }],
    ['invoice subscription', f => { f.invoice.parent.subscription_details.subscription = 'sub_other'; }],
    ['invoice currency', f => { f.invoice.currency = 'eur'; }],
    ['invoice price', f => { f.invoice.lines.data[0]!.pricing.price_details.price = 'price_other'; }],
    ['invoice amount', f => { f.invoice.amount_paid = 3000; f.invoice.amount_due = 3000; }],
    ['invoice payment invoice', f => { f.invoicePayment.invoice = 'in_other'; }],
    ['invoice payment mode', f => { f.invoicePayment.livemode = true; }],
    ['invoice payment object', f => { f.invoicePayment.object = 'invoice'; }],
    ['invoice payment status', f => { f.invoicePayment.status = 'open'; }],
    ['invoice payment amount', f => { f.invoicePayment.amount_paid--; }],
    ['invoice payment currency', f => { f.invoicePayment.currency = 'eur'; }],
    ['intent customer', f => { f.intent.customer = 'cus_other'; }],
    ['intent mode', f => { f.intent.livemode = true; }],
    ['intent amount', f => { f.intent.amount_received--; }],
    ['charge customer', f => { f.charge.customer = 'cus_other'; }],
    ['charge mode', f => { f.charge.livemode = true; }],
    ['charge disputed', f => { f.charge.disputed = true; }],
    ['charge not captured', f => { f.charge.captured = false; }],
    ['charge currency', f => { f.charge.currency = 'eur'; }],
    ['charge intent', f => { f.charge.payment_intent = 'pi_other'; }],
    ['charge partial refund', f => { f.charge.amount_refunded--; }],
    ['refund partial amount', f => { f.refund.amount--; }],
    ['refund still pending', f => { f.refund.status = 'pending'; }],
    ['refund failed', f => { f.refund.status = 'failed'; }],
    ['refund currency', f => { f.refund.currency = 'eur'; }],
    ['refund belongs to other charge', f => { f.refund.charge = 'ch_other'; }],
    ['refund belongs to other intent', f => { f.refund.payment_intent = 'pi_other'; }],
    ['refund fractional amount', f => { f.refund.amount = 2900.1; }],
  ];
  it.each(corruptions)('never closes on conflicting %s', async (_name, corrupt) => {
    const f = fixture(); corrupt(f);
    await expect(f.close()).rejects.toThrow(/PAY_COMMON_.*(CONFLICT|MISMATCH)/);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['subscription', 'invoice'])('refuses %s bound to another test clock after server observation', async object => {
    const f = fixture();
    if (object === 'subscription') f.subscription.test_clock = 'clock_other';
    else f.invoice.test_clock = 'clock_other';
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', expect.anything());
  });
  it('rejects a frozen customer that no longer has a real clock rather than closing the order', async () => {
    const f = fixture();
    f.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, object: 'customer', livemode: false,
      test_clock: null, metadata: { graylum_user_id: USER } } as never);
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('leaves canceled but never refunded payment on its existing path', async () => {
    const f = fixture(); f.charge.refunded = false; f.charge.amount_refunded = 0;
    await expect(f.close()).resolves.toBe(false);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.refunds.list).not.toHaveBeenCalled();
  });
  async function persistClosed(f: ReturnType<typeof fixture>) {
    await f.close();
    const recorded = f.rpc.mock.calls.find(call => call[0] === 'pay_stripe_test_clock_close_refunded')![1] as { p_facts: Record<string, unknown> };
    const facts = structuredClone(recorded.p_facts);
    f.persisted.data = { id: ORDER, user_id: USER, status: 'refunded', payment_status: 'refunded', qualification_state: 'released',
      fulfilled_at: null, subscription_id: null, purchase_closed_at: '2026-10-21T12:00:00Z', metadata: { stripeTestClockClose: facts } };
    f.rpc.mockClear();
    return facts;
  }
  it('allows the exact persisted cash-close through DB duplicate comparison after a later provider dispute', async () => {
    const f = fixture();
    const facts = await persistClosed(f); f.charge.disputed = true;
    f.rpc.mockImplementation(async name => ({ data: name === 'pay_stripe_test_clock_close_refunded'
      ? { state: 'refunded', orderId: ORDER, credits: 0, duplicate: true } : null, error: null }));
    await expect(f.close()).resolves.toBe(true);
    expect(f.from).toHaveBeenCalledWith('payment_orders');
    expect(f.from.mock.results[0]!.value.eq).toHaveBeenCalledWith('id', ORDER);
    expect(f.from.mock.results[0]!.value.eq).toHaveBeenCalledWith('user_id', USER);
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_test_clock_close_refunded', { p_facts: facts });
    expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['pay_stripe_test_clock_close_refunded']);
  });
  it.each([
    { status: 'pending' }, { payment_status: 'paid' }, { qualification_state: 'reserved' }, { purchase_closed_at: null },
    { fulfilled_at: '2026-10-21T12:00:00Z' }, { subscription_id: 'local-subscription' }, { id: 'another-order' }, { user_id: 'other' },
    { metadata: { stripeTestClockClose: true } }, { metadata: { stripeTestClockClose: [] } },
    { metadata: { stripeTestClockClose: { order: 'another-order' } } },
  ])('does not use an incomplete or foreign persisted marker to admit a disputed first close: %j', async patch => {
    const f = fixture(); await persistClosed(f); Object.assign(f.persisted.data!, patch); f.charge.disputed = true;
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', expect.anything());
  });
  it('does not trust a final-close marker supplied on the order when the persisted DB row is absent', async () => {
    const f = fixture(); await persistClosed(f);
    Object.assign(f.order, f.persisted.data); f.persisted.data = null; f.charge.disputed = true;
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', expect.anything());
  });
  it('does not accept changed provider cash facts when the locked duplicate RPC rejects them', async () => {
    const f = fixture(); await persistClosed(f); f.charge.disputed = true; f.refund.id = 're_changed';
    f.rpc.mockImplementation(async name => ({ data: null, error: name === 'pay_stripe_test_clock_close_refunded'
      ? { message: 'PAY_STRIPE_TEST_CLOCK_CLOSE_CONFLICT' } : null }));
    await expect(f.close()).rejects.toThrow('PAY_STRIPE_TEST_CLOCK_CLOSE_UNAVAILABLE');
    expect(f.rpc).toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', { p_facts: expect.objectContaining({
      refunds: [expect.objectContaining({ id: 're_changed' })] }) });
  });
  it('never accepts a nonduplicate DB mutation result for an already disputed charge', async () => {
    const f = fixture(); await persistClosed(f); f.charge.disputed = true;
    f.rpc.mockImplementation(async name => ({ data: name === 'pay_stripe_test_clock_close_refunded'
      ? { state: 'refunded', orderId: ORDER, credits: 0, duplicate: false } : null, error: null }));
    await expect(f.close()).rejects.toThrow('PAY_STRIPE_TEST_CLOCK_CLOSE_UNAVAILABLE');
  });
  it('retains every other provider cash guard even with a valid final-close marker and a dispute', async () => {
    const f = fixture(); await persistClosed(f); f.charge.disputed = true; f.charge.currency = 'eur';
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', expect.anything());
  });
  it('requires tax to match both the session and the invoice pre-tax amount', async () => {
    const f = fixture(580); f.invoice.total_taxes = [];
    await expect(f.close()).rejects.toThrow(/PAY_COMMON_/); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'incomplete', 'empty'])('refuses an %s refund scan', async reason => {
    const f = fixture();
    f.refunds.list.mockResolvedValue(reason === 'duplicate' ? { data: [f.refund, f.refund], has_more: false }
      : { data: [], has_more: reason === 'incomplete' });
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['failed', 'canceled'])('ignores historical %s refund cash when a later successful refund fully repaid the charge', async status => {
    const f = fixture(580);
    f.refunds.list.mockResolvedValue({ data: [{ ...f.refund, id: `re_old_${status}`, status, amount: 3480 }, f.refund], has_more: false });
    await expect(f.close()).resolves.toBe(true);
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_test_clock_close_refunded', { p_facts: expect.objectContaining({
      paidMinor: 3480, taxMinor: 580, refunds: [{ id: f.refund.id, amount: 3480, createdAt: new Date(f.refund.created * 1000).toISOString() }] }) });
  });
  it.each(['failed', 'canceled'].flatMap(status => ['charge', 'intent', 'currency', 'amount', 'timestamp'].map(field => ({ status, field }))))(
    'does not ignore conflicting provider identity or malformed historical refund facts: %j', async ({ status, field }) => {
      const f = fixture();
      const historical = { ...f.refund, id: 're_historical', status };
      if (field === 'charge') historical.charge = 'ch_other';
      if (field === 'intent') historical.payment_intent = 'pi_other';
      if (field === 'currency') historical.currency = 'eur';
      if (field === 'amount') historical.amount = 0.5;
      if (field === 'timestamp') historical.created = -1;
      f.refunds.list.mockResolvedValue({ data: [historical, f.refund], has_more: false });
      await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
      expect(f.rpc).not.toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', expect.anything());
    });
  it.each(['pending', 'requires_action', 'unknown'])('refuses an unresolved %s refund even beside a full successful refund', async status => {
    const f = fixture();
    f.refunds.list.mockResolvedValue({ data: [{ ...f.refund, id: 're_unresolved', status }, f.refund], has_more: false });
    await expect(f.close()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalledWith('pay_stripe_test_clock_close_refunded', expect.anything());
  });
  it('accepts two different successful refund parts only after a complete paginated scan sums to the gross total', async () => {
    const f = fixture();
    f.refunds.list.mockResolvedValueOnce({ data: [{ ...f.refund, id: 're_part1', amount: 1000 }], has_more: true })
      .mockResolvedValueOnce({ data: [{ ...f.refund, id: 're_part2', amount: 1900 }], has_more: false });
    await expect(f.close()).resolves.toBe(true);
    expect(f.refunds.list).toHaveBeenLastCalledWith({ charge: 'ch_fixture', limit: 100, starting_after: 're_part1' });
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_test_clock_close_refunded', { p_facts: expect.objectContaining({
      refunds: [expect.objectContaining({ id: 're_part1', amount: 1000 }), expect.objectContaining({ id: 're_part2', amount: 1900 })] }) });
  });
  it('does not claim success when DB rejects erasure, an existing grant or a dispute race after the provider read', async () => {
    for (const code of ['PAY_ACCOUNT_ERASURE_DENIED', 'PAY_STRIPE_CLOCK_GRANT_EXISTS', 'PAY_DISPUTE_FROZEN']) {
      const f = fixture();
      f.rpc.mockImplementation(async (name: string) => ({ data: null, error: name === 'pay_stripe_test_clock_close_refunded' ? { message: code } : null }));
      await expect(f.close()).rejects.toThrow('PAY_STRIPE_TEST_CLOCK_CLOSE_UNAVAILABLE');
      expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['pay_stripe_test_clock_observe', 'pay_stripe_test_clock_close_refunded']);
    }
  });
  it('submits identical provider facts for repeats/concurrent recovery, leaving single cash booking to the locked RPC', async () => {
    const f = fixture();
    await expect(Promise.all([f.close(), f.close()])).resolves.toEqual([true, true]);
    const facts = f.rpc.mock.calls.filter(call => call[0] === 'pay_stripe_test_clock_close_refunded').map(call => call[1]);
    expect(facts).toHaveLength(2); expect(facts[0]).toEqual(facts[1]);
    expect(f.rpc.mock.calls.every(call => ['pay_stripe_test_clock_observe', 'pay_stripe_test_clock_close_refunded'].includes(call[0]))).toBe(true);
  });
});
