/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewSubscriptionRefund, readSubscriptionRefundFacts } from './subscriptionRefundPreview';
import { actorId, request, fixture, type Row } from './__tests__/subscriptionRefundPreviewFixture';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z') }));
afterEach(() => vi.useRealTimers());

/** PAY-STRIPE-MP step 4b-2: an international card subscription (Managed Payments) charged 69.00 + 13.80 tax. Its
 * first invoice is its 'payment' reference and the tax is recorded for that invoice (0237). */
async function cardFixture(tax: Row[] = [{ kind: 'tax', amount: '13.80', evidence_ref: 'in_fixture' }]) {
  const f = fixture();
  Object.assign(f.order, { payment_method: 'card', payment_amount_facts: tax });
  f.tables.payment_provider_refs = f.tables.payment_provider_refs.filter(row => row.object_type === 'subscription')
    .concat({ id: 'map_card', order_id: f.order.id, subscription_id: null, object_type: 'payment', external_id: 'in_fixture',
      channel: 'stripe', mode: 'test', merchant_namespace: 'acct_fixture' });
  f.invoices[0].amount_paid = 8280;
  const intent = await f.stripe.paymentIntents.retrieve(); intent.amount_received = 8280;
  f.stripe.paymentIntents.retrieve.mockResolvedValue(intent);
  const charge = await f.stripe.charges.retrieve(); charge.amount = charge.amount_captured = 8280;
  f.stripe.charges.retrieve.mockResolvedValue(charge);
  const payments = await f.stripe.invoicePayments.list(); payments.data[0].amount_paid = 8280;
  f.stripe.invoicePayments.list.mockResolvedValue(payments);
  return f;
}

describe('card subscription first-purchase refund evidence (PAY-STRIPE-MP)', () => {
  it('binds the card order through its payment reference; the fee is on the pre-tax amount and the tax comes back', async () => {
    const f = await cardFixture();
    const facts = await readSubscriptionRefundFacts(f.db, f.provider, actorId, request);
    expect([facts.policy.order.paidMinor, facts.provider.cash.taxMinor]).toEqual([6900, 1380]);
    expect(await previewSubscriptionRefund(f.db, f.provider, actorId, request)).toMatchObject({ status: 'eligible',
      quote: { basisMinor: 6900, feeMinor: 414, netMinor: 6486 } });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('ignores a card checkout that never took money, but not one that did', async () => {
    const f = await cardFixture();
    const abandoned = { ...f.order, id: '77777777-7777-4777-8777-777777777777', status: 'expired', payment_status: 'unpaid',
      fulfilled_at: null, subscription_id: null, payment_amount_facts: null };
    f.tables.payment_orders.push(abandoned);
    expect(await previewSubscriptionRefund(f.db, f.provider, actorId, request)).toMatchObject({ status: 'eligible' });
    abandoned.payment_status = 'paid';
    expect(await previewSubscriptionRefund(f.db, f.provider, actorId, request)).toMatchObject({ status: 'review_required' });
  });
  it('needs the recorded tax, and amounts that match the pre-tax amount plus that tax', async () => {
    const untaxed = await cardFixture([]);
    expect(await previewSubscriptionRefund(untaxed.db, untaxed.provider, actorId, request)).toMatchObject({ status: 'review_required' });
    const f = await cardFixture([{ kind: 'tax', amount: '13.79', evidence_ref: 'in_fixture' }]);
    expect(await previewSubscriptionRefund(f.db, f.provider, actorId, request)).toMatchObject({ status: 'review_required' });
    // A card order mapped as a legacy invoice is not the card history it claims to be.
    const legacy = await cardFixture();
    legacy.tables.payment_provider_refs.forEach(row => { if (row.object_type === 'payment') row.object_type = 'invoice'; });
    expect(await previewSubscriptionRefund(legacy.db, legacy.provider, actorId, request)).toMatchObject({ status: 'review_required' });
  });
});
