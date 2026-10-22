/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { loadStripeBillingDocument } from './stripeBillingDocument';
import { projectOrderPayment } from './orderProjection';
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn() } }));

describe('Stripe document projection failures', () => {
  const order = { id: 'order-document', user_id: 'user-document', payment_channel: 'stripe',
    merchant_namespace: 'acct_fixture', payment_mode: 'test', price_ref_id: 'price-ref',
    amount_total: 100, currency: 'usd', item_id: 'item', item_type: 'credit_package',
    billing_cycle: 'one_time', status: 'completed', payment_status: 'paid', created_at: '2026-10-05',
    fulfilled_at: '2026-10-05', stripe_invoice_id: null, stripe_checkout_session_id: null } as const;
  function setup(document: Record<string, unknown> | Error, invoice = true) {
    const retrieve = vi.fn(async () => { if (document instanceof Error) throw document; return document; });
    const stripe = { accounts: { retrieveCurrent: async () => ({ id: 'acct_fixture' }) },
      balance: { retrieve: async () => ({ livemode: false }) }, invoices: { retrieve },
      checkout: { sessions: { retrieve } } } as unknown as Parameters<typeof loadStripeBillingDocument>[0];
    const db = { from: () => ({ select() { return this; }, eq() { return this; },
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: { external_id: 'price_fixture' }, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{
        object_type: invoice ? 'invoice' : 'checkout', external_id: invoice ? 'in_fixture' : 'cs_fixture',
      }], error: null }).then(resolve),
    }) } as unknown as Parameters<typeof loadStripeBillingDocument>[1];
    return { stripe, db };
  }
  it('reports missing client, provider failure and inconsistent evidence as unknown', async () => {
    const { db } = setup({});
    expect(projectOrderPayment(order, await loadStripeBillingDocument(null, db, order)).documentStatus).toBe('unknown');
    for (const document of [new Error('provider offline'), { id: 'wrong', livemode: false, amount_paid: 100, currency: 'usd' }]) {
      const fixture = setup(document);
      const result = await loadStripeBillingDocument(fixture.stripe, fixture.db, order);
      expect(projectOrderPayment(order, result).documentStatus).toBe('unknown');
      expect(result.invoicePdfUrl).toBeNull();
    }
  });
  it.each([null, 'https://invoice.stripe.com/fixture'])('only verified absence is unavailable: %s', async url => {
    const { stripe, db } = setup({ id: 'in_fixture', livemode: false, amount_paid: 100, currency: 'usd', invoice_pdf: url });
    expect(projectOrderPayment(order, await loadStripeBillingDocument(stripe, db, order)).documentStatus)
      .toBe(url ? 'available' : 'unavailable');
  });
  it.each(['wechat_pay', 'alipay'])('loads a verified %s membership receipt without a provider subscription', async payment_method => {
    const receipt = 'https://pay.stripe.com/receipts/fixture';
    const { stripe, db } = setup({ id: 'cs_fixture', livemode: false, amount_total: 100, currency: 'usd',
      metadata: { userId: order.user_id, orderId: order.id }, payment_intent: { latest_charge: { receipt_url: receipt } } }, false);
    const membership = { ...order, item_type: 'membership_plan', billing_cycle: 'monthly' as const, payment_method,
      subscription_id: 'internal-membership' };
    const result = await loadStripeBillingDocument(stripe, db, membership);
    expect(result.receiptUrl).toBe(receipt);
    expect(projectOrderPayment(membership, result).documentStatus).toBe('available');
  });
  it.each(['userId', 'orderId'])('rejects another wallet member receipt with mismatched %s', async key => {
    const { stripe, db } = setup({ id: 'cs_fixture', livemode: false, amount_total: 100, currency: 'usd',
      metadata: { userId: order.user_id, orderId: order.id, [key]: 'other' },
      payment_intent: { latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/other' } } }, false);
    const result = await loadStripeBillingDocument(stripe, db, { ...order, payment_method: 'alipay',
      subscription_id: 'internal-membership', item_type: 'membership_plan' });
    expect(result.receiptUrl).toBeNull();
    expect(projectOrderPayment(order, result).documentStatus).toBe('unknown');
  });
  it.each(['pi_unexpanded', { latest_charge: 'ch_unexpanded' }])(
    'does not treat an unexpanded receipt as confirmed absence: %j', async paymentIntent => {
    const { stripe, db } = setup({ id: 'cs_fixture', livemode: false, amount_total: 100, currency: 'usd',
      metadata: { userId: order.user_id, orderId: order.id }, payment_intent: paymentIntent }, false);
    expect(projectOrderPayment(order, await loadStripeBillingDocument(stripe, db, order)).documentStatus).toBe('unknown');
  });
});
