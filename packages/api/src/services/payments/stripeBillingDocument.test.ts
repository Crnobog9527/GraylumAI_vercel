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
  it('verifies a Managed Payments invoice whose paid total includes the tax added on top', async () => {
    // user12 founder annual: order amount_total 49600 (pre-tax), Stripe charged 52080 with 2480 tax.
    const founder = { ...order, amount_total: 49600, item_type: 'membership_plan', billing_cycle: 'yearly' as const };
    const { stripe, db } = setup({ id: 'in_fixture', livemode: false, amount_paid: 52080, currency: 'usd',
      total_taxes: [{ amount: 2480 }], invoice_pdf: 'https://invoice.stripe.com/fixture' });
    expect(projectOrderPayment(founder, await loadStripeBillingDocument(stripe, db, founder)).documentStatus).toBe('available');
  });
  it('verifies a checkout receipt whose total includes Stripe tax', async () => {
    const receipt = 'https://pay.stripe.com/receipts/fixture';
    const { stripe, db } = setup({ id: 'cs_fixture', livemode: false, amount_total: 105, total_details: { amount_tax: 5 },
      currency: 'usd', metadata: { userId: order.user_id, orderId: order.id },
      payment_intent: { latest_charge: { receipt_url: receipt } } }, false);
    const result = await loadStripeBillingDocument(stripe, db, order);
    expect(result.receiptUrl).toBe(receipt);
    expect(projectOrderPayment(order, result).documentStatus).toBe('available');
  });
  it.each([
    ['tax does not explain the difference', { amount_paid: 52080, total_taxes: [{ amount: 2000 }] }],
    ['tax-inclusive total with no tax reported', { amount_paid: 52080 }],
    ['pre-tax total but tax reported on top', { amount_paid: 49600, total_taxes: [{ amount: 2480 }] }],
    ['tax larger than the total', { amount_paid: 100, total_taxes: [{ amount: -49500 }] }],
    ['another currency', { amount_paid: 52080, total_taxes: [{ amount: 2480 }], currency: 'eur' }],
  ])('still reports a real invoice mismatch as unknown: %s', async (_name, patch) => {
    const founder = { ...order, amount_total: 49600 };
    const { stripe, db } = setup({ id: 'in_fixture', livemode: false, currency: 'usd',
      invoice_pdf: 'https://invoice.stripe.com/fixture', ...patch });
    const result = await loadStripeBillingDocument(stripe, db, founder);
    expect(result.invoicePdfUrl).toBeNull();
    expect(projectOrderPayment(founder, result).documentStatus).toBe('unknown');
  });
  it('still reports a checkout total that tax does not explain as unknown', async () => {
    const { stripe, db } = setup({ id: 'cs_fixture', livemode: false, amount_total: 110, total_details: { amount_tax: 5 },
      currency: 'usd', metadata: { userId: order.user_id, orderId: order.id },
      payment_intent: { latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/fixture' } } }, false);
    expect(projectOrderPayment(order, await loadStripeBillingDocument(stripe, db, order)).documentStatus).toBe('unknown');
  });
  describe('card subscription invoice recorded as the payment reference (0238)', () => {
    const invoice = { id: 'in_card', livemode: false, amount_paid: 3045, total_taxes: [{ amount: 145 }], currency: 'usd',
      number: 'CARD-0001', invoice_pdf: 'https://pay.stripe.com/invoice/card/pdf', hosted_invoice_url: 'https://invoice.stripe.com/i/card' };
    function cardSetup(paymentRef: string) {
      const retrieve = vi.fn(async (id: string) => {
        if (id !== invoice.id) throw new Error('unexpected invoice');
        return invoice;
      });
      const stripe = { accounts: { retrieveCurrent: async () => ({ id: 'acct_fixture' }) },
        balance: { retrieve: async () => ({ livemode: false }) }, invoices: { retrieve },
        checkout: { sessions: { retrieve: vi.fn(async () => { throw new Error('session not expected'); }) } },
      } as unknown as Parameters<typeof loadStripeBillingDocument>[0];
      const db = { from: () => ({ select() { return this; }, eq() { return this; },
        limit: async () => ({ data: [{ external_id: paymentRef }], error: null }),
        maybeSingle: async () => ({ data: { external_id: 'price_fixture' }, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [
          { object_type: 'checkout', external_id: 'cs_card' }, { object_type: 'payment', external_id: paymentRef },
        ], error: null }).then(resolve),
      }) } as unknown as Parameters<typeof loadStripeBillingDocument>[1];
      return { stripe, db, retrieve };
    }
    const card = { ...order, item_type: 'membership_plan', billing_cycle: 'monthly' as const, amount_total: 2900,
      payment_method: 'card', subscription_id: 'internal-card-subscription' };
    it.each(['card', 'card_cn'])('shows the %s first-period or renewal invoice', async payment_method => {
      const { stripe, db, retrieve } = cardSetup('in_card');
      const result = await loadStripeBillingDocument(stripe, db, { ...card, payment_method });
      expect(retrieve).toHaveBeenCalledWith('in_card');
      expect(result).toMatchObject({ invoiceNumber: 'CARD-0001', invoicePdfUrl: invoice.invoice_pdf,
        hostedInvoiceUrl: invoice.hosted_invoice_url });
      expect(projectOrderPayment(card, result).documentStatus).toBe('available');
    });
    it('does not read a PaymentIntent payment reference as an invoice', async () => {
      const { stripe, db, retrieve } = cardSetup('pi_card');
      const result = await loadStripeBillingDocument(stripe, db, card);
      expect(retrieve).not.toHaveBeenCalled();
      expect(result.invoicePdfUrl).toBeNull();
    });
  });
});
