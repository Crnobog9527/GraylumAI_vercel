/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { buildStripeCheckoutRequest, dispatchStripeCheckoutIntent, MANAGED_PAYMENTS_TAX_CODE,
  type StripeCardCheckout, type StripeCheckoutIntent } from './stripeCheckoutIntent';

const scope = { merchant: 'fixture_merchant', mode: 'test' as const };
const orderId = '22222222-2222-4222-8222-222222222222';
const plan = '11111111-1111-4111-8111-111111111111';
// PAY-STRIPE-MP 0222: card first month = standard 69 subscription price - 20 one-time coupon.
const firstMonth = { version: 1, item_type: 'membership_plan', item_id: plan, item_updated_at: '2026-10-05T00:00:00.000Z',
  billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '69.00', discount: '20.00', tax_behavior: 'exclusive',
  credits: 8970, bonus_credits: 0 };
const pack = { ...firstMonth, item_type: 'credit_package', billing_cycle: 'one_time', price: '8.90', discount: '0.00',
  credits: 990 };
const mp: StripeCardCheckout = { managedPayments: true, couponId: 'coupon_first' };

function fixture(snapshot = firstMonth, card: StripeCardCheckout = mp) {
  const request = buildStripeCheckoutRequest({ orderId, userId: 'fixture_user', snapshot, priceId: 'price_gold_month',
    productName: 'Fixture', appUrl: 'https://example.test', expiresAt: 5000, card });
  const intent: StripeCheckoutIntent = { id: orderId, userId: 'fixture_user', scope, snapshot, priceId: 'price_gold_month',
    request, sessionId: null, card };
  const recurring = snapshot.item_type === 'membership_plan';
  const session = { id: 'cs_fixture', object: 'checkout.session', livemode: false, client_reference_id: intent.userId,
    metadata: request.metadata, amount_total: recurring ? 4900 : 890, currency: 'usd', mode: request.mode,
    total_details: { amount_tax: 0 }, managed_payments: card.managedPayments ? { enabled: true } : null };
  const product = { id: 'prod_gold', object: 'product', active: true, tax_code: MANAGED_PAYMENTS_TAX_CODE };
  const price = { id: 'price_gold_month', object: 'price', active: true, livemode: false, currency: 'usd',
    unit_amount: recurring ? 6900 : 890, billing_scheme: 'per_unit', tax_behavior: 'exclusive', product,
    type: recurring ? 'recurring' : 'one_time', recurring: recurring ? { interval: 'month', interval_count: 1, usage_type: 'licensed' } : null };
  const coupon = { id: 'coupon_first', object: 'coupon', valid: true, livemode: false, percent_off: null, amount_off: 2000,
    currency: 'usd', duration: 'once', applies_to: { products: ['prod_gold'] } };
  const prices = { retrieve: vi.fn().mockResolvedValue(price) };
  const coupons = { retrieve: vi.fn().mockResolvedValue(coupon) };
  const sessions = { list: vi.fn().mockResolvedValue({ data: [], has_more: false }), retrieve: vi.fn().mockResolvedValue(session),
    create: vi.fn().mockResolvedValue(session) };
  const persistSession = vi.fn().mockResolvedValue(undefined);
  const args = { stripe: { prices, coupons, checkout: { sessions } } as unknown as Pick<Stripe, 'prices' | 'checkout' | 'coupons'>,
    intent, scope, persistSession, now: 1000, createIfMissing: true };
  return { args, request, prices, coupons, sessions, persistSession, session, price, coupon, product };
}

describe('PAY-STRIPE-MP card checkout request', () => {
  it('builds Managed Payments subscriptions with the server-selected coupon and no payment method list', () => {
    const { request } = fixture();
    expect(request).toMatchObject({ mode: 'subscription', managed_payments: { enabled: true },
      line_items: [{ price: 'price_gold_month', quantity: 1 }], discounts: [{ coupon: 'coupon_first' }] });
    for (const key of ['payment_method_types', 'customer_creation', 'automatic_tax', 'custom_text', 'billing_address_collection']) {
      expect(request).not.toHaveProperty(key);
    }
  });
  it('builds a Managed Payments one-time pack and a plain mainland card subscription', () => {
    expect(fixture(pack, { managedPayments: true }).request).toMatchObject({ mode: 'payment', managed_payments: { enabled: true },
      line_items: [{ price: 'price_gold_month', quantity: 1 }] });
    expect(fixture(pack, { managedPayments: true }).request).not.toHaveProperty('discounts');
    const cn = fixture({ ...firstMonth, price: '69.00', discount: '0.00' }, { managedPayments: false }).request;
    expect(cn).toMatchObject({ mode: 'subscription', payment_method_types: ['card'], billing_address_collection: 'required' });
    expect(cn).not.toHaveProperty('managed_payments');
  });
  it('refuses a discounted subscription without the coupon and a coupon anywhere else', () => {
    expect(() => fixture(firstMonth, { managedPayments: true })).toThrow('PAY_COMMON_SUBSCRIPTION_DISCOUNT_UNSUPPORTED');
    expect(() => fixture(pack, mp)).toThrow('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    expect(() => fixture({ ...firstMonth, discount: '0.00' }, mp)).toThrow('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    expect(() => fixture(firstMonth, { managedPayments: true, couponId: 'bad id' })).toThrow('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
  });
});

describe('PAY-STRIPE-MP card checkout dispatch', () => {
  it('creates the session after checking price, tax code and coupon, and accepts tax added on top', async () => {
    const t = fixture();
    t.session.amount_total = 5880; t.session.total_details = { amount_tax: 980 };
    await expect(dispatchStripeCheckoutIntent(t.args)).resolves.toBe(t.session);
    expect(t.prices.retrieve).toHaveBeenCalledWith('price_gold_month', { expand: ['product'] });
    expect(t.coupons.retrieve).toHaveBeenCalledWith('coupon_first');
    expect(t.sessions.create).toHaveBeenCalledTimes(1); expect(t.persistSession).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['payment method list on MP', (r: Stripe.Checkout.SessionCreateParams) => { r.payment_method_types = ['card']; }],
    ['MP switched off', (r: Stripe.Checkout.SessionCreateParams) => { delete r.managed_payments; }],
    ['other coupon', (r: Stripe.Checkout.SessionCreateParams) => { r.discounts = [{ coupon: 'coupon_other' }]; }],
    ['promotion code', (r: Stripe.Checkout.SessionCreateParams) => { r.discounts = [{ promotion_code: 'promo' }]; }],
    ['inline price', (r: Stripe.Checkout.SessionCreateParams) => {
      r.line_items = [{ price_data: { currency: 'usd', unit_amount: 4900, product: 'prod_gold' }, quantity: 1 }]; }],
  ])('refuses a tampered persisted request: %s', async (_name, tamper) => {
    const t = fixture(); tamper(t.args.intent.request);
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    expect(t.sessions.create).not.toHaveBeenCalled();
  });
  it.each([
    ['product without tax code', (t: ReturnType<typeof fixture>) => { t.product.tax_code = null as unknown as string; }],
    ['renewal price not 69', (t: ReturnType<typeof fixture>) => { t.price.unit_amount = 4900; }],
    ['coupon amount', (t: ReturnType<typeof fixture>) => { t.coupon.amount_off = 3000; }],
    ['coupon repeats', (t: ReturnType<typeof fixture>) => { t.coupon.duration = 'forever'; }],
    ['percent coupon', (t: ReturnType<typeof fixture>) => { (t.coupon as { percent_off: number | null }).percent_off = 29; }],
    ['expired coupon', (t: ReturnType<typeof fixture>) => { t.coupon.valid = false; }],
    ['coupon for another product', (t: ReturnType<typeof fixture>) => { t.coupon.applies_to = { products: ['prod_pro'] }; }],
  ])('refuses before creating a session when Stripe is misconfigured: %s', async (_name, change) => {
    const t = fixture(); change(t);
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('PAY_COMMON_PRICE_MISMATCH');
    expect(t.sessions.create).not.toHaveBeenCalled();
  });
  it('rejects a created session whose Managed Payments flag or pre-tax amount does not match', async () => {
    const off = fixture(); off.session.managed_payments = null;
    await expect(dispatchStripeCheckoutIntent(off.args)).rejects.toThrow('PAY_COMMON_RECEIPT_MISMATCH');
    const cheap = fixture(); cheap.session.amount_total = 5880; cheap.session.total_details = { amount_tax: 0 };
    await expect(dispatchStripeCheckoutIntent(cheap.args)).rejects.toThrow('PAY_COMMON_RECEIPT_MISMATCH');
    expect(off.persistSession).not.toHaveBeenCalled(); expect(cheap.persistSession).not.toHaveBeenCalled();
  });
  it('recovers the existing session instead of creating a second one', async () => {
    const t = fixture(); t.args.intent.sessionId = 'cs_fixture';
    await expect(dispatchStripeCheckoutIntent(t.args)).resolves.toBe(t.session);
    expect(t.sessions.create).not.toHaveBeenCalled(); expect(t.coupons.retrieve).not.toHaveBeenCalled();
  });
});
