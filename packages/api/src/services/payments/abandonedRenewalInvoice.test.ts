/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { isAbandonedRenewalInvoice } from './abandonedRenewalInvoice';

const invoice = (patch: Record<string, unknown> = {}) => ({ id: 'in_dead', object: 'invoice', status: 'open', amount_paid: 0,
  next_payment_attempt: null, livemode: false, parent: { subscription_details: { subscription: 'sub_dead' } },
  ...patch }) as unknown as Stripe.Invoice;
const stripe = (status = 'canceled', patch: Record<string, unknown> = {}, latest?: Record<string, unknown>) => {
  const retrieve = vi.fn(async (id: string) => ({ id, livemode: false, status, ...patch }));
  const retrieveInvoice = vi.fn(async () => invoice(latest));
  return { client: { subscriptions: { retrieve }, invoices: { retrieve: retrieveInvoice } } as unknown as
    Pick<Stripe, 'subscriptions' | 'invoices'>, retrieve, retrieveInvoice };
};

describe('isAbandonedRenewalInvoice', () => {
  it('skips an unpaid open invoice with no further attempt under a canceled subscription', async () => {
    const { client, retrieve, retrieveInvoice } = stripe();
    expect(await isAbandonedRenewalInvoice(client, invoice(), false)).toBe(true);
    expect(retrieve).toHaveBeenCalledWith('sub_dead');
    expect(retrieveInvoice).toHaveBeenCalledWith('in_dead');
  });
  it.each([
    ['paid after it was listed', { status: 'paid', amount_paid: 3045 }],
    ['given another attempt after it was listed', { next_payment_attempt: 1798199939 }],
    ['partly paid after it was listed', { amount_paid: 100 }],
  ])('re-reads the invoice after the subscription: keeps it when %s', async (_name, latest) => {
    expect(await isAbandonedRenewalInvoice(stripe('canceled', {}, latest).client, invoice(), false)).toBe(false);
  });
  it.each([
    ['Stripe will still retry it', { next_payment_attempt: 1798199939 }],
    ['part of it was paid', { amount_paid: 100 }],
    ['it is a draft', { status: 'draft' }],
    ['the buyer has since paid it', { status: 'paid', amount_paid: 3045 }],
    ['another mode', { livemode: true }],
    ['no subscription', { parent: null }],
  ])('keeps it when %s', async (_name, patch) => {
    expect(await isAbandonedRenewalInvoice(stripe().client, invoice(patch), false)).toBe(false);
  });
  it.each(['active', 'past_due', 'unpaid', 'incomplete'])('keeps it while the subscription is %s', async status => {
    expect(await isAbandonedRenewalInvoice(stripe(status).client, invoice(), false)).toBe(false);
  });
  it('keeps it when Stripe returns another subscription or mode', async () => {
    expect(await isAbandonedRenewalInvoice(stripe('canceled', { id: 'sub_other' }).client, invoice(), false)).toBe(false);
    expect(await isAbandonedRenewalInvoice(stripe('canceled', { livemode: true }).client, invoice(), false)).toBe(false);
  });
});
