/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerState = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  logger: loggerState,
}));

import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  markMembershipInvoicePaymentFailed,
  upsertPaymentOrderBySession,
} from '../stripeFulfillment';

describe('stripe fulfillment helpers', () => {
  beforeEach(() => {
    loggerState.error.mockReset();
    loggerState.info.mockReset();
    loggerState.warn.mockReset();
  });

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

  it('persists stripe_subscription_id while keeping paid checkout sessions pending until fulfillment', async () => {
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
        status: 'pending',
        payment_status: 'paid',
      }),
    );
  });

  it('preserves completed fulfilled checkout orders during paid session replay', async () => {
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
              data: {
                id: 'order-completed',
                status: 'completed',
                fulfilled_at: '2026-03-22T12:00:00.000Z',
                metadata: {
                  transactionId: 'txn-1',
                  grantedCredits: 100,
                },
              },
              error: null,
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
        };
      },
    };

    await upsertPaymentOrderBySession(
      supabase,
      {
        id: 'cs_test_replay_completed',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
          billingCycle: 'one_time',
          priceId: 'price_test_package',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        amount_total: 1000,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
      } as Stripe.Checkout.Session,
      {
        eventType: 'checkout.session.completed',
      },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        payment_status: 'paid',
        metadata: expect.objectContaining({
          transactionId: 'txn-1',
          grantedCredits: 100,
          lastPaymentOrderStatus: 'completed',
          lastPaymentOrderStatusSource: 'checkout.session.completed',
        }),
      }),
    );
  });

  it('marks expired checkout sessions as terminal without fulfillment', async () => {
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
              data: {
                id: 'order-expired',
                status: 'pending',
                fulfilled_at: null,
                metadata: {},
              },
              error: null,
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
        };
      },
    };

    await upsertPaymentOrderBySession(
      supabase,
      {
        id: 'cs_test_expired',
        status: 'expired',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
          billingCycle: 'one_time',
          priceId: 'price_test_package',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        amount_total: 1000,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'unpaid',
      } as Stripe.Checkout.Session,
      {
        eventType: 'checkout.session.expired',
      },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        status: 'expired',
        payment_status: 'unpaid',
        metadata: expect.objectContaining({
          lastPaymentOrderStatus: 'expired',
          lastPaymentOrderStatusSource: 'checkout.session.expired',
        }),
      }),
    );
  });

  it('throws a diagnostic error when checkout order update fails', async () => {
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
              data: { id: 'order-update-fail' },
              error: null,
            });
          },
          update() {
            return {
              eq() {
                return Promise.resolve({
                  error: {
                    code: '42501',
                    message: 'permission denied for table payment_orders',
                  },
                });
              },
            };
          },
          insert() {
            throw new Error('insert should not be called for an existing order');
          },
        };
      },
    };

    await expect(
      upsertPaymentOrderBySession(
        supabase,
        {
          id: 'cs_test_upsert_update_failure',
          metadata: {
            userId: 'user-1',
            itemType: 'membership_plan',
            itemId: 'plan-1',
            billingCycle: 'monthly',
            priceId: 'price_test_monthly',
          },
          client_reference_id: 'user-1',
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          amount_total: 990,
          currency: 'usd',
          mode: 'subscription',
          payment_status: 'paid',
        } as Stripe.Checkout.Session,
      ),
    ).rejects.toMatchObject({
      name: 'StripeFulfillmentError',
      stage: 'upsert_payment_order_update',
      safeContext: expect.objectContaining({
        supabaseError: expect.objectContaining({
          code: '42501',
          message: 'permission denied for table payment_orders',
        }),
      }),
    });

    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'stripe_fulfillment_stage_failed',
      expect.objectContaining({
        stage: 'upsert_payment_order_update',
        supabaseError: expect.objectContaining({ code: '42501' }),
      }),
    );
  });

  it('throws a diagnostic error when checkout order insert fails', async () => {
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
            return Promise.resolve({ data: null, error: null });
          },
          insert() {
            return Promise.resolve({
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint for cs_test_insert_failure',
              },
            });
          },
        };
      },
    };

    await expect(
      upsertPaymentOrderBySession(
        supabase,
        {
          id: 'cs_test_insert_failure',
          metadata: {
            userId: 'user-1',
            itemType: 'membership_plan',
            itemId: 'plan-1',
            billingCycle: 'monthly',
            priceId: 'price_test_monthly',
          },
          client_reference_id: 'user-1',
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          amount_total: 990,
          currency: 'usd',
          mode: 'subscription',
          payment_status: 'paid',
        } as Stripe.Checkout.Session,
      ),
    ).rejects.toMatchObject({
      name: 'StripeFulfillmentError',
      stage: 'upsert_payment_order_insert',
      safeContext: expect.objectContaining({
        supabaseError: expect.objectContaining({
          code: '23505',
          message: expect.stringContaining('cs_test_...ailure'),
        }),
      }),
    });
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

  it('marks the pending subscription checkout order failed when the first invoice payment fails', async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown>; orderId?: string }> = [];

    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_failed');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_failed');
              return this;
            }

            if (column === 'id') {
              updates[updates.length - 1].orderId = value;
              return Promise.resolve({ error: null });
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          is(column: string, value: null) {
            expect(column).toBe('stripe_invoice_id');
            expect(value).toBeNull();
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-pending-subscription',
                status: 'pending',
                fulfilled_at: null,
                metadata: {
                  existing: 'kept',
                },
              },
              error: null,
            });
          },
          update(payload: Record<string, unknown>) {
            updates.push({ table, payload });
            return this;
          },
        };
      },
    };

    await markMembershipInvoicePaymentFailed(
      supabase,
      {
        id: 'in_test_failed',
        status: 'open',
        amount_due: 2990,
        amount_paid: 0,
        currency: 'usd',
        parent: {
          subscription_details: {
            subscription: 'sub_test_failed',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([
      {
        table: 'payment_orders',
        orderId: 'order-pending-subscription',
        payload: expect.objectContaining({
          stripe_invoice_id: 'in_test_failed',
          stripe_subscription_id: 'sub_test_failed',
          amount_total: 2990,
          currency: 'usd',
          status: 'failed',
          payment_status: 'open',
          metadata: expect.objectContaining({
            existing: 'kept',
            source: 'invoice.payment_failed',
            invoiceId: 'in_test_failed',
            subscriptionId: 'sub_test_failed',
            lastPaymentOrderStatus: 'failed',
            lastPaymentOrderStatusSource: 'invoice.payment_failed',
          }),
        }),
      },
    ]);
  });

  it('parses subscription id from the legacy invoice.subscription shape', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          fulfilled_at: '2026-03-22T12:34:56.000Z',
        },
      ],
      error: null,
    });

    const supabase = {
      rpc,
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_legacy_shape');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_legacy_shape');
              return {
                is() {
                  return Promise.resolve({ error: null });
                },
              };
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          update() {
            return this;
          },
        };
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_legacy_shape',
        customer: 'cus_test_legacy',
        status: 'paid',
        currency: 'usd',
        amount_paid: 990,
        subscription: 'sub_test_legacy_shape',
      } as Stripe.Invoice,
    );

    expect(rpc).toHaveBeenCalledWith(
      'atomic_fulfill_membership_invoice',
      expect.objectContaining({
        p_invoice_id: 'in_test_legacy_shape',
        p_subscription_id: 'sub_test_legacy_shape',
      }),
    );
  });

  it('logs the fulfillment stage and safe Supabase error when the membership RPC fails', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'subscription order not found for invoice in_test_rpc_failure',
      },
    });

    const supabase = {
      rpc,
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_rpc_failure');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
        };
      },
    };

    await expect(
      fulfillMembershipInvoice(
        supabase,
        {
          id: 'in_test_rpc_failure',
          customer: 'cus_test_rpc',
          status: 'paid',
          currency: 'usd',
          amount_paid: 990,
          parent: {
            subscription_details: {
              subscription: 'sub_test_rpc_failure',
            },
          },
        } as Stripe.Invoice,
      ),
    ).rejects.toMatchObject({
      name: 'StripeFulfillmentError',
      stage: 'fulfill_membership_invoice_rpc',
      safeContext: expect.objectContaining({
        invoiceId: 'in_test_...ailure',
        subscriptionId: 'sub_test...ailure',
        supabaseError: expect.objectContaining({
          code: 'P0001',
          message: 'subscription order not found for invoice in_test_...ailure',
        }),
      }),
    });

    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'stripe_fulfillment_stage_failed',
      expect.objectContaining({
        stage: 'fulfill_membership_invoice_rpc',
        invoiceId: 'in_test_...ailure',
        subscriptionId: 'sub_test...ailure',
        supabaseError: expect.objectContaining({
          code: 'P0001',
        }),
      }),
    );
  });
});
