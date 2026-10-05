/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { retrievePaidStripeInvoice, validateInvoiceSource } from './stripeInvoiceEvidence';
const conflict = vi.hoisted(() => vi.fn());
vi.mock('./stripeConflictEvidence', () => ({ recordStripeInvoiceConflict: conflict }));
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const item = '11111111-1111-4111-8111-111111111111';
const source = { id: '22222222-2222-4222-8222-222222222222', user_id: 'owner', item_id: item,
  payment_channel: 'stripe', merchant_namespace: scope.merchant, payment_mode: scope.mode,
  billing_cycle: 'monthly', purchase_membership_level: 'pro', stripe_customer_id: 'cus_fixture',
  purchase_snapshot: { version: 1, item_type: 'membership_plan', item_id: item,
    item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
    price: '19.99', discount: '0.00', tax_behavior: 'unspecified', credits: 100, bonus_credits: 0 } };
const input = { scope, invoiceId: 'in_fixture', subscriptionId: 'sub_fixture', providerSubscriptionStatus: 'active',
  providerSubscriptionUserId: 'owner', paymentStatus: 'paid', currency: 'usd', amountTotal: 1999, stripeCustomerId: 'cus_fixture' };
const db = {} as Parameters<typeof validateInvoiceSource>[0];
describe('invoice conflict evidence routing', () => {
  beforeEach(() => conflict.mockReset().mockResolvedValue(undefined));
  it.each([{ amountTotal: 2000 }, { stripeCustomerId: 'cus_other' }, { providerSubscriptionUserId: 'other' }])(
    'persists evidence for amount or ownership rejection %j', async patch => {
      await expect(validateInvoiceSource(db, { ...input, ...patch }, source)).rejects.toThrow('MISMATCH');
      expect(conflict).toHaveBeenCalledWith({ db, scope, invoiceId: input.invoiceId, sourceOrderId: source.id });
    },
  );
  it('does not record a transport error as evidence conflict', async () => {
    const stripe = { invoices: { retrieve: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) } } as unknown as Stripe;
    await expect(retrievePaidStripeInvoice(db, stripe, scope, 'in_fixture')).rejects.toThrow('ETIMEDOUT');
    expect(conflict).not.toHaveBeenCalled();
  });
  it('leaves matching evidence unchanged', async () => {
    await expect(validateInvoiceSource(db, input, source)).resolves.toEqual(source.purchase_snapshot);
    expect(conflict).not.toHaveBeenCalled();
  });
});
