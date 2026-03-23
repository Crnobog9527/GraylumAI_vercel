/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  upsertPaymentOrderBySession,
} from '../stripeFulfillment';

describe('stripe fulfillment helpers', () => {
  it('skips credit package fulfillment when the checkout session is already fulfilled', async () => {
    const updates: Array<{ table: string; payload: unknown }> = [];

    const supabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              expect(column).toBe('stripe_checkout_session_id');
              expect(value).toBe('cs_test_credit_replay');
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: 'order-credit-1',
                  fulfilled_at: '2026-03-12T16:01:26.787Z',
                },
              });
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table access during replay: ${table}`);
      },
    };

    await fulfillCreditPackageOrder(
      supabase,
      {
        id: 'cs_test_credit_replay',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
        },
        client_reference_id: 'user-1',
        payment_status: 'paid',
        mode: 'payment',
      } as Stripe.Checkout.Session,
    );

    expect(updates).toEqual([]);
  });

  it('persists stripe_subscription_id when checkout session has an expanded subscription object', async () => {
    const updates: unknown[] = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe('payment_orders');

        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { id: 'order-1' },
            });
          },
          update(payload: unknown) {
            updates.push(payload);
            return {
              eq() {
                return Promise.resolve({ error: null });
              },
            };
          },
          insert() {
            throw new Error('insert should not be called for an existing order');
          },
        };
      },
    };

    await upsertPaymentOrderBySession(
      supabase,
      {
        id: 'cs_test_subscription',
        metadata: {
          userId: 'user-1',
          itemType: 'membership_plan',
          itemId: 'plan-1',
          billingCycle: 'monthly',
          priceId: 'price_test_monthly',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        subscription: {
          id: 'sub_test_123',
        },
        amount_total: 990,
        currency: 'usd',
        mode: 'subscription',
        payment_status: 'paid',
      } as Stripe.Checkout.Session,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        stripe_checkout_session_id: 'cs_test_subscription',
        stripe_customer_id: 'cus_test_123',
        stripe_subscription_id: 'sub_test_123',
        stripe_price_id: 'price_test_monthly',
        status: 'completed',
        payment_status: 'paid',
      }),
    );
  });

  it('backfills checkout order fulfillment when invoice fulfillment already exists', async () => {
    const updates: Array<{ table: string; payload: unknown }> = [];
    let profileTouched = false;
    let transactionsTouched = false;
    let subscriptionTouched = false;

    const supabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              if (column === 'stripe_invoice_id') {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: {
                        id: 'invoice-order-1',
                        fulfilled_at: '2026-03-12T14:58:21.498Z',
                      },
                    });
                  },
                };
              }

              if (column === 'stripe_subscription_id') {
                return {
                  is(nullColumn: string, nullValue: null) {
                    expect(nullColumn).toBe('stripe_invoice_id');
                    expect(nullValue).toBeNull();
                    return Promise.resolve({ error: null });
                  },
                };
              }

              throw new Error(`Unexpected eq(${column}, ${value})`);
            },
            order() {
              throw new Error('order should not be called when invoice order already exists');
            },
            limit() {
              throw new Error('limit should not be called when invoice order already exists');
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return this;
            },
            insert() {
              throw new Error('insert should not be called when invoice order already exists');
            },
          };
        }

        if (table === 'profiles') {
          profileTouched = true;
          throw new Error('profiles should not be touched during invoice replay');
        }

        if (table === 'credit_transactions') {
          transactionsTouched = true;
          throw new Error('credit_transactions should not be touched during invoice replay');
        }

        if (table === 'user_subscriptions') {
          subscriptionTouched = true;
          throw new Error('user_subscriptions should not be touched during invoice replay');
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_123',
        customer: 'cus_test_123',
        status: 'paid',
        currency: 'usd',
        amount_paid: 990,
        parent: {
          subscription_details: {
            subscription: 'sub_test_123',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([
      {
        table: 'payment_orders',
        payload: expect.objectContaining({
          fulfilled_at: '2026-03-12T14:58:21.498Z',
          status: 'completed',
          payment_status: 'paid',
        }),
      },
    ]);
    expect(profileTouched).toBe(false);
    expect(transactionsTouched).toBe(false);
    expect(subscriptionTouched).toBe(false);
  });

  it('delegates pending credit package fulfillment to the atomic RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          fulfilled_at: '2026-03-22T12:00:00.000Z',
        },
      ],
      error: null,
    });

    const supabase = {
      rpc,
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table access: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            expect(column).toBe('stripe_checkout_session_id');
            expect(value).toBe('cs_test_credit_atomic');
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-credit-atomic',
                fulfilled_at: null,
              },
            });
          },
        };
      },
    };

    await fulfillCreditPackageOrder(
      supabase,
      {
        id: 'cs_test_credit_atomic',
        metadata: {
          userId: 'user-atomic',
          itemType: 'credit_package',
          itemId: 'package-atomic',
        },
        client_reference_id: 'user-atomic',
        payment_status: 'paid',
        mode: 'payment',
      } as Stripe.Checkout.Session,
    );

    expect(rpc).toHaveBeenCalledWith('atomic_fulfill_credit_package', {
      p_checkout_session_id: 'cs_test_credit_atomic',
      p_payment_status: 'paid',
    });
  });

  it('delegates pending membership invoice fulfillment to the atomic RPC and backfills checkout order', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          fulfilled_at: '2026-03-22T12:34:56.000Z',
        },
      ],
      error: null,
    });
    const updates: Array<{ table: string; payload: unknown }> = [];

    const supabase = {
      rpc,
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              if (column === 'stripe_invoice_id') {
                expect(value).toBe('in_test_atomic');
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: null });
                  },
                };
              }

              if (column === 'stripe_subscription_id') {
                expect(value).toBe('sub_test_atomic');
                return {
                  is(nullColumn: string, nullValue: null) {
                    expect(nullColumn).toBe('stripe_invoice_id');
                    expect(nullValue).toBeNull();
                    return Promise.resolve({ error: null });
                  },
                };
              }

              throw new Error(`Unexpected eq(${column}, ${value})`);
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return this;
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_atomic',
        customer: 'cus_test_atomic',
        status: 'paid',
        currency: 'usd',
        amount_paid: 1990,
        period_start: 1_742_646_400,
        period_end: 1_745_238_400,
        parent: {
          subscription_details: {
            subscription: 'sub_test_atomic',
          },
        },
      } as Stripe.Invoice,
    );

    expect(rpc).toHaveBeenCalledWith('atomic_fulfill_membership_invoice', {
      p_amount_total: 1990,
      p_currency: 'usd',
      p_invoice_id: 'in_test_atomic',
      p_payment_status: 'paid',
      p_period_end: '2025-04-21T12:26:40.000Z',
      p_period_start: '2025-03-22T12:26:40.000Z',
      p_stripe_customer_id: 'cus_test_atomic',
      p_subscription_id: 'sub_test_atomic',
    });
    expect(updates).toEqual([
      {
        table: 'payment_orders',
        payload: expect.objectContaining({
          fulfilled_at: '2026-03-22T12:34:56.000Z',
          payment_status: 'paid',
          status: 'completed',
        }),
      },
    ]);
  });
});
