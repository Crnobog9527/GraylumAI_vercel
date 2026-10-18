/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { readDisputePayment } from './disputePayment';
const scope = { merchant: 'acct_test', mode: 'test' as const };
function fixture() {
  const charge = { object: 'charge', id: 'ch_test', payment_intent: 'pi_test' as string | null, livemode: false, created: 1792300000 };
  const invoice = { object: 'invoice', id: 'in_test', livemode: false, parent: { subscription_details: { subscription: 'sub_test' } } };
  const rows = { has_more: false, data: [{ invoice: 'in_test', payment: { type: 'payment_intent', payment_intent: 'pi_test' } }] };
  const api = { charges: { retrieve: vi.fn(async () => charge) },
    paymentIntents: { retrieve: vi.fn(async () => ({ object: 'payment_intent', id: 'pi_test', livemode: false, latest_charge: 'ch_test' })) },
    invoicePayments: { list: vi.fn(async () => rows) }, invoices: { retrieve: vi.fn(async () => invoice) } };
  return { charge, invoice, rows, api, stripe: api as unknown as Stripe };
}
describe('canonical dispute payment identity', () => {
  it('charge without a PaymentIntent field, invoice and checkout evidence resolve to the same PaymentIntent', async () => {
    const f = fixture();
    const fromCharge = await readDisputePayment(f.stripe, scope, { chargeId: 'ch_test' });
    expect(await readDisputePayment(f.stripe, scope, { invoiceId: 'in_test' })).toEqual(fromCharge);
    expect(await readDisputePayment(f.stripe, scope, { paymentIntentId: 'pi_test' })).toEqual(fromCharge);
    expect(fromCharge).toMatchObject({ paymentIntentId: 'pi_test', invoiceId: 'in_test', subscriptionId: 'sub_test' });
    expect(fromCharge.paymentAt).toBe(new Date(f.charge.created * 1000).toISOString());
  });
  it('one-time payment has no invoice or subscription', async () => {
    const f = fixture(); f.rows.data = [];
    await expect(readDisputePayment(f.stripe, scope, { chargeId: 'ch_test' })).resolves.toMatchObject({ invoiceId: null, subscriptionId: null });
  });
  it('identifies a verified direct charge without a PaymentIntent for bounded webhook handling', async () => {
    const f = fixture();
    f.charge.payment_intent = null;
    await expect(readDisputePayment(f.stripe, scope, { chargeId: 'ch_test' })).rejects.toThrow('PAY_DISPUTE_PAYMENT_INTENT_MISSING');
    f.charge.livemode = true;
    await expect(readDisputePayment(f.stripe, scope, { chargeId: 'ch_test' })).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
  });
  it.each(['charge mode', 'charge identity', 'intent mismatch', 'invoice mode', 'incomplete history'])(
    'refuses unverified %s before any database mutation', async kind => {
      const f = fixture();
      if (kind === 'charge mode') f.charge.livemode = true;
      if (kind === 'charge identity') f.charge.id = 'ch_other';
      if (kind === 'intent mismatch') f.charge.payment_intent = 'pi_other';
      if (kind === 'invoice mode') f.invoice.livemode = true;
      if (kind === 'incomplete history') f.rows.has_more = true;
      await expect(readDisputePayment(f.stripe, scope, { chargeId: 'ch_test', paymentIntentId: 'pi_test' }))
        .rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    });
});
