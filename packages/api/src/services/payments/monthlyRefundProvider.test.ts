/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMonthlyProvider, stageKey, type MonthlyStripe } from './monthlyRefundProvider';
import { executionFixture, now } from './__tests__/monthlyRefundExecutionFixture';
import type { MonthlyRefundTerms } from './monthlyRefundApproval';
const modulePath = new URL('../../../../db/tests/monthly-refund/provider.mjs', import.meta.url).href;
const fixtureModule = await import(/* @vite-ignore */ modulePath) as {
  provider(input: { terms: MonthlyRefundTerms; user: string; order: string }): {
    stripe: MonthlyStripe; sub: Stripe.Subscription; charge: Stripe.Charge; invoice: Stripe.Invoice;
    events: Stripe.Event[]; refunds: Stripe.Refund[]; writes: unknown[];
  };
};
beforeEach(() => vi.useFakeTimers({ now: new Date(now) }));
afterEach(() => vi.useRealTimers());
function fixture() {
  const { intent } = executionFixture();
  intent.terms.merchant = 'acct_fixture';
  return { ...fixtureModule.provider({ terms: intent.terms, user: intent.terms.userId, order: intent.terms.orderId }), intent };
}
describe('monthly original-channel evidence reader', () => {
  it('checks the original merchant, invoice, captured cash and fixed monthly term without any write', async () => {
    const f = fixture();
    expect(await readMonthlyProvider(f.stripe, f.intent)).toMatchObject({ mode: 'test',
      subscription: { preflight: 'clear', renewalOwnership: 'original' }, refunds: { complete: true, rows: [] } });
    expect(f.writes).toEqual([]);
  });
  it.each(['disputed', 'schedule', 'pending_update', 'pending_setup_intent', 'invoice', 'pendingItems'])('%s blocks new external steps', async field => {
    const f = fixture();
    if (field === 'disputed') f.charge.disputed = true;
    if (field === 'schedule') f.sub.schedule = 'schedule_unknown';
    if (field === 'pending_update') f.sub.pending_update = { expires_at: 1 } as Stripe.Subscription.PendingUpdate;
    if (field === 'pending_setup_intent') f.sub.pending_setup_intent = 'seti_unknown';
    if (field === 'invoice') f.invoice.status = 'open';
    if (field === 'pendingItems') f.stripe.invoiceItems.list = vi.fn(async () => ({ data: [{ id: 'ii_pending' }], has_more: false })) as unknown as MonthlyStripe['invoiceItems']['list'];
    expect((await readMonthlyProvider(f.stripe, f.intent)).subscription.preflight).toBe('conflict');
    expect(f.writes).toEqual([]);
  });
  it.each(['year', 'metered', 'wrong-customer', 'live', 'currency', 'term'])('rejects %s authoritative scope drift', async field => {
    const f = fixture();
    if (field === 'year') f.sub.items.data[0].price.recurring!.interval = 'year';
    if (field === 'metered') f.sub.items.data[0].price.recurring!.usage_type = 'metered';
    if (field === 'wrong-customer') f.sub.customer = 'cus_wrong';
    if (field === 'live') f.charge.livemode = true;
    if (field === 'currency') f.charge.currency = 'eur';
    if (field === 'term') f.sub.items.data[0].current_period_end++;
    await expect(readMonthlyProvider(f.stripe, f.intent)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it('proves renewal ownership from the original request key, not metadata alone', async () => {
    const f = fixture(); f.intent.claimedAt = now;
    await f.stripe.subscriptions.update(f.sub.id, { cancel_at_period_end: true,
      metadata: { graylum_monthly_refund_intent: f.intent.id } }, { idempotencyKey: stageKey(f.intent, 'stop_renewal') });
    expect((await readMonthlyProvider(f.stripe, f.intent)).subscription.renewalOwnership).toBe('intent');
    f.events[0].request!.idempotency_key = 'different-actor';
    expect((await readMonthlyProvider(f.stripe, f.intent)).subscription.renewalOwnership).toBe('unknown');
    f.events.length = 0;
    expect((await readMonthlyProvider(f.stripe, f.intent)).subscription.renewalOwnership).toBe('unknown');
  });
  it('rejects ambiguous same-second renewal transitions', async () => {
    const f = fixture(); f.intent.claimedAt = now;
    await f.stripe.subscriptions.update(f.sub.id, { cancel_at_period_end: true,
      metadata: { graylum_monthly_refund_intent: f.intent.id } }, { idempotencyKey: stageKey(f.intent, 'stop_renewal') });
    f.events.push({ ...f.events[0], id: 'evt_competing' });
    expect((await readMonthlyProvider(f.stripe, f.intent)).subscription.renewalOwnership).toBe('unknown');
  });
  it('requires a complete bounded list and rejects non-progressing pages', async () => {
    const f = fixture();
    f.stripe.invoices.list = vi.fn(async () => ({ data: [f.invoice], has_more: true })) as unknown as MonthlyStripe['invoices']['list'];
    await expect(readMonthlyProvider(f.stripe, f.intent)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it('retains a verified cash success while a separate unpaid invoice blocks cancellation', async () => {
    const f = fixture();
    await f.stripe.refunds.create({ charge: f.intent.terms.chargeId, amount: f.intent.terms.netMinor,
      metadata: { orderId: f.intent.terms.orderId, refundIntentId: f.intent.id } }, { idempotencyKey: stageKey(f.intent, 'refund') });
    f.stripe.invoices.list = vi.fn(async () => ({ data: [f.invoice, { ...f.invoice, id: 'in_other', status: 'open' }], has_more: false })) as unknown as MonthlyStripe['invoices']['list'];
    expect(await readMonthlyProvider(f.stripe, f.intent)).toMatchObject({ subscription: { preflight: 'conflict' },
      refunds: { rows: [{ status: 'succeeded' }] } });
    f.refunds[0].metadata!.refundIntentId = 'other-intent';
    await expect(readMonthlyProvider(f.stripe, f.intent)).rejects.toThrow();
  });
});
