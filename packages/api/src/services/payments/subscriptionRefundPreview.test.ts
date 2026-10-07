/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewSubscriptionRefund } from './subscriptionRefundPreview';
import { actorId, subjectId, request, paidAt, fixture, type Row } from './__tests__/subscriptionRefundPreviewFixture';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z') }));
afterEach(() => vi.useRealTimers());
const run = (f: ReturnType<typeof fixture>, input = request) => previewSubscriptionRefund(f.db, f.provider, actorId, input);
async function unresolved(f: ReturnType<typeof fixture>) {
  expect(await run(f)).toMatchObject({ status: 'review_required', quote: null, executable: false });
  expect(f.write).not.toHaveBeenCalled();
}
describe('subscription refund read-only preview', () => {
  it.each(['monthly', 'yearly'])('assembles complete %s first-purchase evidence', async cycle => {
    const f = fixture();
    f.snapshot.billing_cycle = f.order.billing_cycle = cycle === 'monthly' ? 'monthly' : 'yearly';
    const result = await run(f);
    expect(result).toMatchObject({ status: 'eligible', executable: false, treatment: 'first_purchase',
      quote: { basisMinor: 6900, feeMinor: 414, netMinor: 6486 } });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reads.every(read => !read.select.includes('*') && !read.select.includes('description'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TEXT_CANARY');
    expect(await run(f)).toEqual(result);
  });
  it('uses an annual founder-priced frozen contract without changing founder identity or slots', async () => {
    const f = fixture(); f.snapshot.billing_cycle = f.order.billing_cycle = 'yearly';
    f.snapshot.price = '496'; f.order.amount_total = 49600; f.invoices[0].amount_paid = 49600;
    const intent = await f.stripe.paymentIntents.retrieve(); intent.amount_received = 49600;
    f.stripe.paymentIntents.retrieve.mockResolvedValue(intent);
    const charge = await f.stripe.charges.retrieve(); charge.amount = charge.amount_captured = 49600;
    f.stripe.charges.retrieve.mockResolvedValue(charge);
    const payments = await f.stripe.invoicePayments.list(); payments.data[0].amount_paid = 49600;
    f.stripe.invoicePayments.list.mockResolvedValue(payments);
    expect(await run(f)).toMatchObject({ status: 'eligible', treatment: 'first_purchase', executable: false,
      quote: { basisMinor: 49600, feeMinor: 2976, netMinor: 46624 } });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('binds subscription cash through the original invoice even without a package-style payment ref', async () => {
    const f = fixture();
    f.tables.payment_provider_refs = f.tables.payment_provider_refs.filter(row => row.object_type !== 'payment');
    expect(await run(f)).toMatchObject({ status: 'eligible', executable: false });
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each([
    ['2026-10-07T23:59:59.999999Z', 'eligible'],
    ['2026-10-08T00:00:00.000000Z', 'eligible'],
    ['2026-10-08T00:00:00.000001Z', 'rejected'],
  ])('uses the authoritative payment to ticket boundary %s', async (time, status) => {
    const f = fixture(); f.tables.tickets[0].created_at = time;
    expect(await run(f)).toMatchObject({ status, executable: false });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('supports prohibited/unknown fee applicability without a client amount', async () => {
    const f = fixture();
    expect(await previewSubscriptionRefund(f.db, f.provider, actorId, { ...request, feePermitted: 'not_permitted' }))
      .toMatchObject({ quote: { feeMinor: 0, netMinor: 6900 }, executable: false });
    expect(await previewSubscriptionRefund(f.db, f.provider, actorId, { ...request, feePermitted: 'unknown' }))
      .toMatchObject({ status: 'review_required', quote: null, executable: false });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rejects renewal and never implements upgrade recovery', async () => {
    const f = fixture(); f.invoices[0].billing_reason = 'subscription_cycle';
    expect(await run(f)).toMatchObject({ status: 'rejected', reason: 'renewal', executable: false });
    f.invoices[0].billing_reason = 'subscription_update';
    await unresolved(f);
  });
  it.each(['ended', 'refunded', 'another-plan', 'same-second'])('does not mistake %s history for first purchase', async kind => {
    const f = fixture();
    f.tables.payment_orders.push({ ...f.order, id: 'old-order', status: kind === 'refunded' ? 'refunded' : 'completed',
      item_id: kind === 'another-plan' ? 'other-plan' : f.order.item_id });
    f.tables.payment_provider_refs.push({ ...f.tables.payment_provider_refs[1], id: 'map_old', order_id: 'old-order', external_id: 'in_old' });
    f.invoices.push({ ...structuredClone(f.invoices[0]), id: 'in_old', status_transitions: {
      paid_at: Date.parse(kind === 'same-second' ? paidAt : '2026-09-01T00:00:00Z') / 1000 } });
    const result = await run(f);
    expect(result).toMatchObject({ status: kind === 'same-second' ? 'review_required' : 'rejected', executable: false, quote: null });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('does not ignore a paid invoice missing from local history', async () => {
    const f = fixture(); f.invoices.push({ ...f.invoices[0], id: 'in_not_delivered' }); await unresolved(f);
  });
  it('does not subtract positive returns from historical consumption in any source', async () => {
    const f = fixture();
    f.tables.credit_transactions.push({ ...f.tables.credit_transactions[0], id: 'tx_spend', amount: -1, ledger_type: 'spend',
      counts_as_spend: true, source_order_id: null, source_type: 'opening' },
    { ...f.tables.credit_transactions[0], id: 'tx_return', amount: 1, source_order_id: null });
    expect(await run(f)).toMatchObject({ status: 'rejected', reason: 'account_consumed_since_payment', executable: false });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('includes holds started before payment and requires linked settlement', async () => {
    const f = fixture();
    f.tables.billing_history.push({ id: 'hold_old', user_id: subjectId, operation_type: 'pre_deduct', metadata: {} });
    await unresolved(f);
    f.tables.billing_history.push({ id: 'settled', user_id: subjectId, operation_type: 'settle', metadata: { preDeductId: 'hold_old' } });
    expect(await run(f)).toMatchObject({ status: 'eligible', executable: false });
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['actor', 'subject', 'ticket-subject', 'ticket-category', 'deleted-ticket', 'snapshot', 'grant', 'mapping', 'live', 'waffo'])
    ('fails closed for %s before provider access', async kind => {
      const f = fixture();
      if (kind === 'actor') f.tables.profiles[0].role = 'user';
      if (kind === 'subject') f.tables.profiles[1].is_deleted = 'true';
      if (kind === 'ticket-subject') f.tables.tickets[0].user_id = actorId;
      if (kind === 'ticket-category') f.tables.tickets[0].category = 'general';
      if (kind === 'deleted-ticket') f.tables.tickets[0].is_deleted = 'true';
      if (kind === 'snapshot') f.order.purchase_snapshot = null as never;
      if (kind === 'grant') f.tables.subscription_credit_grants[0].grant_snapshot = null;
      if (kind === 'mapping') f.tables.payment_provider_refs = [];
      if (kind === 'live') f.order.payment_mode = 'live';
      if (kind === 'waffo') f.order.payment_channel = 'waffo';
      await unresolved(f);
      expect(f.stripe.refunds.create).not.toHaveBeenCalled();
    });
  it.each(['db', 'provider', 'dispute', 'refund', 'currency', 'invoice-payment', 'capture-time'])
    ('returns safe non-executable review for %s', async kind => {
      const f = fixture();
      if (kind === 'db') f.hook.mockImplementation(() => { throw new Error('PRIVATE_TEXT_CANARY'); });
      if (kind === 'provider') f.stripe.invoices.list.mockRejectedValue(new Error('PRIVATE_TEXT_CANARY'));
      if (kind === 'dispute' || kind === 'currency' || kind === 'capture-time') {
        const cash = await f.stripe.charges.retrieve();
        if (kind === 'dispute') cash.disputed = true;
        if (kind === 'currency') cash.currency = 'eur';
        if (kind === 'capture-time') cash.balance_transaction.created += 1;
        f.stripe.charges.retrieve.mockResolvedValue(cash);
      }
      if (kind === 'refund') f.stripe.refunds.list.mockResolvedValue({ data: [{ id: 're_other' }], has_more: false });
      if (kind === 'invoice-payment') {
        const payments = await f.stripe.invoicePayments.list(); payments.data[0].payment.payment_intent = 'pi_other';
        f.stripe.invoicePayments.list.mockResolvedValue(payments);
      }
      await unresolved(f);
      expect(JSON.stringify(await run(f))).not.toContain('PRIVATE_TEXT_CANARY');
    });
  it('detects evidence clearing or mutation during provider reads', async () => {
    const f = fixture();
    f.stripe.invoices.list.mockImplementation(async () => {
      f.tables.subscription_credit_grants[0].grant_snapshot = null;
      return { data: structuredClone(f.invoices), has_more: false };
    });
    await unresolved(f);
  });
  it('detects provider drift rather than accepting the initial view', async () => {
    const f = fixture(); f.stripe.invoices.list.mockImplementationOnce(async () => ({ data: structuredClone(f.invoices), has_more: false }));
    f.stripe.invoices.list.mockResolvedValue({ data: [], has_more: false }); await unresolved(f);
  });
  it('reads every page and rejects duplicates/caps rather than trusting latest-N', async () => {
    const f = fixture();
    for (let n = 0; n < 101; n++) f.tables.credit_transactions.push({ ...f.tables.credit_transactions[0], id: `tx_${n}`,
      source_order_id: null, amount: 1, source_type: 'opening' });
    expect(await run(f)).toMatchObject({ status: 'eligible', executable: false });
    f.tables.credit_transactions.push({ ...f.tables.credit_transactions[0] }); await unresolved(f);
    f.tables.credit_transactions = Array.from({ length: 2001 }, (_, n) => ({ ...f.tables.credit_transactions[0], id: `tx_${n}` }));
    await unresolved(f);
  });
  it('detects count changes between local pages', async () => {
    const f = fixture();
    for (let n = 0; n < 101; n++) f.tables.credit_transactions.push({ ...f.tables.credit_transactions[0], id: `tx_${n}` });
    let reads = 0;
    f.hook.mockImplementation((table, rows) => table === 'credit_transactions' && ++reads > 1 ? rows.slice(1) : rows);
    await unresolved(f);
  });
  it('follows provider pagination and refuses incomplete/repeated cursors', async () => {
    const f = fixture(); let reads = 0;
    f.stripe.invoices.list.mockImplementation(async () => (++reads % 2)
      ? { data: structuredClone(f.invoices), has_more: true } : { data: [], has_more: false });
    expect(await run(f)).toMatchObject({ status: 'eligible', executable: false });
    f.stripe.invoices.list.mockResolvedValue({ data: structuredClone(f.invoices), has_more: true }); await unresolved(f);
    f.stripe.invoices.list.mockResolvedValue({ data: [], has_more: true }); await unresolved(f);
  });
  it('refuses unknown negative ledger semantics', async () => {
    const f = fixture(); f.tables.credit_transactions.push({ ...f.tables.credit_transactions[0], id: 'unknown',
      amount: -1, ledger_type: null, type: 'deduction', source_type: null, idempotency_key: null, counts_as_spend: null } as Row);
    await unresolved(f);
  });
});
