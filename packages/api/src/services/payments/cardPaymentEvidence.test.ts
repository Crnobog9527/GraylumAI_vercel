/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { readCardPaymentEvidence, type CardOrder } from './cardPaymentEvidence';

const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const orderId = '00000000-0000-4000-8000-000000000001';
const firstMonth = { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000002',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '69.00',
  discount: '20.00', tax_behavior: 'exclusive', credits: 8970, bonus_credits: 0 };
const pack = { ...firstMonth, item_type: 'credit_package', billing_cycle: 'one_time', price: '9.40', discount: '0.00', credits: 990 };

// Shapes follow the sandbox objects in docs/launch/evidence/stripe-managed-payments-20261012/02a.
function fixture(method: 'card' | 'card_cn' = 'card', snapshot: Record<string, unknown> = firstMonth) {
  const membership = snapshot.item_type === 'membership_plan';
  const order: CardOrder = { id: orderId, user_id: 'user', purchase_snapshot: snapshot, payment_method: method,
    item_type: String(snapshot.item_type), payment_channel: 'stripe', merchant_namespace: scope.merchant, payment_mode: 'test',
    stripe_managed_payments: method === 'card' };
  const due = membership ? 4900 : 940;
  const session = { object: 'checkout.session', id: 'cs_1', livemode: false, client_reference_id: 'user', customer: 'cus_1',
    metadata: { userId: 'user', orderId }, mode: membership ? 'subscription' : 'payment', payment_status: 'paid', status: 'complete',
    managed_payments: method === 'card' ? { enabled: true } : null, payment_method_types: method === 'card' ? ['card', 'link'] : ['card'],
    amount_total: due, total_details: { amount_tax: 0 }, currency: 'usd', subscription: 'sub_1', invoice: 'in_1',
    payment_intent: membership ? null : 'pi_1' };
  const subscription = { object: 'subscription', id: 'sub_1', livemode: false, metadata: { userId: 'user', orderId }, customer: 'cus_1',
    managed_payments: method === 'card' ? { enabled: true } : null,
    items: { data: [{ price: { id: 'price_gold_month' }, quantity: 1, current_period_start: 1791794554, current_period_end: 1794472954 }] } };
  const invoice = { object: 'invoice', id: 'in_1', livemode: false, status: 'paid', billing_reason: 'subscription_create', currency: 'usd',
    amount_due: due, amount_paid: due, total_taxes: [] as Array<{ amount: number }>, status_transitions: { paid_at: 1791794560 },
    parent: { subscription_details: { subscription: 'sub_1' } } };
  const intent = { object: 'payment_intent', id: 'pi_1', livemode: false, status: 'succeeded', latest_charge: 'ch_1', customer: 'cus_1',
    metadata: { userId: 'user', orderId }, amount_received: due, currency: 'usd' };
  const charge = { object: 'charge', id: 'ch_1', livemode: false, paid: true, captured: true, status: 'succeeded', payment_intent: 'pi_1',
    refunded: false, amount_refunded: 0, customer: 'cus_1', amount_captured: due, currency: 'usd', created: 1791794560 };
  const stripe = { checkout: { sessions: { retrieve: vi.fn(async () => session) } },
    subscriptions: { retrieve: vi.fn(async () => subscription) }, invoices: { retrieve: vi.fn(async () => invoice) },
    paymentIntents: { retrieve: vi.fn(async () => intent) }, charges: { retrieve: vi.fn(async () => charge) } };
  const read = () => readCardPaymentEvidence({ stripe: stripe as unknown as Parameters<typeof readCardPaymentEvidence>[0]['stripe'],
    scope, order, priceId: 'price_gold_month', sessionId: 'cs_1' });
  return { order, session, subscription, invoice, intent, charge, read };
}

describe('PAY-STRIPE-MP card first-payment evidence', () => {
  it('reads a paid first month from the subscription\'s first invoice and the Stripe period', async () => {
    await expect(fixture().read()).resolves.toEqual({ paymentId: 'in_1', checkoutId: 'cs_1', amount: 4900, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z',
      subscription: { id: 'sub_1', start: '2026-10-12T08:42:34.000Z', end: '2026-11-12T08:42:34.000Z' } });
    await expect(fixture('card_cn').read()).resolves.toMatchObject({ amount: 4900, subscription: { id: 'sub_1' } });
  });
  it('compares pre-tax amounts: tax Managed Payments adds on top is excluded', async () => {
    const t = fixture();
    t.session.amount_total = 5880; t.session.total_details = { amount_tax: 980 };
    t.invoice.amount_due = 5880; t.invoice.amount_paid = 5880; t.invoice.total_taxes = [{ amount: 980 }];
    await expect(t.read()).resolves.toMatchObject({ amount: 4900 });
    const p = fixture('card', pack);
    p.session.amount_total = 1128; p.session.total_details = { amount_tax: 188 };
    p.intent.amount_received = 1128; p.charge.amount_captured = 1128;
    await expect(p.read()).resolves.toEqual({ paymentId: 'pi_1', checkoutId: 'cs_1', amount: 940, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z', subscription: null });
  });
  it('returns null while the session is unpaid', async () => {
    const t = fixture(); t.session.payment_status = 'unpaid';
    await expect(t.read()).resolves.toBeNull();
  });
  it.each([
    ['another owner', (t: ReturnType<typeof fixture>) => { t.session.metadata.userId = 'other'; }],
    ['Managed Payments off for card', (t: ReturnType<typeof fixture>) => { t.session.managed_payments = null; }],
    ['subscription for another order', (t: ReturnType<typeof fixture>) => { t.subscription.metadata.orderId = 'x'; }],
    ['another price', (t: ReturnType<typeof fixture>) => { t.subscription.items.data[0]!.price.id = 'price_other'; }],
    ['renewal invoice', (t: ReturnType<typeof fixture>) => { t.invoice.billing_reason = 'subscription_cycle'; }],
    ['unpaid invoice', (t: ReturnType<typeof fixture>) => { t.invoice.status = 'open'; }],
    ['invoice of another subscription', (t: ReturnType<typeof fixture>) => {
      t.invoice.parent.subscription_details.subscription = 'sub_2'; }],
    ['tax hidden in the invoice total', (t: ReturnType<typeof fixture>) => { t.invoice.amount_due = 5880; t.invoice.amount_paid = 5880; }],
    ['wrong session total', (t: ReturnType<typeof fixture>) => { t.session.amount_total = 6900; }],
  ])('refuses %s', async (_name, change) => {
    const t = fixture(); change(t);
    await expect(t.read()).rejects.toThrow(/PAY_WAFFO_PAYMENT_CONFLICT|PAY_COMMON_RECEIPT_MISMATCH/);
  });
  it('refuses a mainland card session with other methods, MP turned on, or a mainland card pack', async () => {
    const cn = fixture('card_cn'); cn.session.payment_method_types = ['card', 'alipay'];
    await expect(cn.read()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    const mp = fixture('card_cn'); mp.session.managed_payments = { enabled: true };
    await expect(mp.read()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    await expect(fixture('card_cn', pack).read()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
  });
  it('refuses a refunded or uncaptured pack charge', async () => {
    const t = fixture('card', pack); t.charge.amount_refunded = 940; t.charge.refunded = true;
    await expect(t.read()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
  });
});
