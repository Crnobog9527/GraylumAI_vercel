/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { hasUnpaidSubscription, unpaidRenewalEntry } from './methodPurchaseError';

type Filters = Array<[string, string, unknown]>;
function db(rows: { failed?: unknown[]; renewing?: Array<Record<string, unknown>> }, seen: Filters[] = []) {
  return { from: () => {
    const filters: Filters = [];
    seen.push(filters);
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters.push(['eq', column, value]); return chain; },
      in: (column: string, value: unknown) => { filters.push(['in', column, value]); return chain; },
      lt: (column: string, value: unknown) => { filters.push(['lt', column, value]); return chain; },
      limit: async () => ({ data: filters.some(([op, column]) => op === 'lt' && column === 'current_period_end')
        ? rows.renewing ?? [] : rows.failed ?? [], error: null }),
    };
    return chain;
  } } as unknown as Parameters<typeof hasUnpaidSubscription>[0];
}

describe('hasUnpaidSubscription', () => {
  const now = Date.parse('2026-12-25T00:00:00Z');
  it('keeps the provider past_due, incomplete and unpaid statuses', async () => {
    expect(await hasUnpaidSubscription(db({ failed: [{ id: 'sub' }] }), 'user', now)).toBe(true);
  });
  it('treats a still-renewing Stripe card period that ended past the 24-hour grace as unpaid', async () => {
    const seen: Filters[] = [];
    expect(await hasUnpaidSubscription(db({ renewing: [{ id: 'sub', cancel_at_period_end: 'false' }] }, seen), 'user', now))
      .toBe(true);
    expect(seen[1]).toEqual(expect.arrayContaining([['eq', 'user_id', 'user'], ['eq', 'status', 'active'],
      ['eq', 'payment_channel', 'stripe'], ['lt', 'current_period_end', '2026-12-24T00:00:00.000Z']]));
    expect(await hasUnpaidSubscription(db({ renewing: [{ id: 'sub', cancel_at_period_end: false }] }), 'user', now)).toBe(true);
  });
  it('does not flag a period that stops at its end (cancel requested, wallet term) or nothing overdue', async () => {
    expect(await hasUnpaidSubscription(db({ renewing: [{ id: 'sub', cancel_at_period_end: 'true' }] }), 'user', now)).toBe(false);
    expect(await hasUnpaidSubscription(db({ renewing: [{ id: 'sub', cancel_at_period_end: null }] }), 'user', now)).toBe(false);
    expect(await hasUnpaidSubscription(db({}), 'user', now)).toBe(false);
  });
  it('keeps the ordinary wording when the read fails', async () => {
    const broken = { from: () => { throw new Error('offline'); } } as unknown as Parameters<typeof hasUnpaidSubscription>[0];
    expect(await hasUnpaidSubscription(broken, 'user', now)).toBe(false);
  });
});

describe('unpaidRenewalEntry', () => {
  const entry = { planId: 'p', allowed: true, state: 'free', action: 'createCheckout', reasonCode: 'OK', safeMessage: '' };
  it('turns an offered checkout into the resolve-payment notice for an unpaid buyer', () => {
    expect(unpaidRenewalEntry(entry, true)).toMatchObject({ planId: 'p', allowed: false, state: 'payment_attention',
      action: 'resolvePaymentIssue', reasonCode: 'PAYMENT_ATTENTION_REQUIRED' });
  });
  it('leaves other buyers and already refused entries unchanged', () => {
    expect(unpaidRenewalEntry(entry, false)).toBe(entry);
    const refused = { ...entry, allowed: false, action: 'contactSupport' };
    expect(unpaidRenewalEntry(refused, true)).toBe(refused);
  });
});
