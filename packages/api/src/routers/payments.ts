/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import {
  assertStripeCheckoutConfigured,
  buildStripeMetadata,
  calculateDiscountedAmountCents,
  getOrCreateStripeCustomerId,
  getStripeAppUrl,
  getStripeClient,
} from '../services/stripe';
import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '../services/stripeFulfillment';

const createCheckoutInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('credit_package'),
    packageId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('membership_plan'),
    planId: z.string().uuid(),
    billingCycle: z.enum(['monthly', 'yearly']),
  }),
]);

const syncCheckoutInput = z.object({
  sessionId: z.string().min(1),
});

type BillingRecord = {
  id: string;
  itemType: 'credit_package' | 'membership_plan';
  title: string;
  description: string;
  status: string;
  amountTotal: number;
  currency: string;
  billingCycle: 'one_time' | 'monthly' | 'yearly';
  createdAt: string;
  fulfilledAt: string | null;
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  receiptUrl: string | null;
};

type PaymentOrderBillingRow = {
  id: string;
  item_id: string;
  item_type: 'credit_package' | 'membership_plan' | string;
  billing_cycle: 'one_time' | 'monthly' | 'yearly' | null;
  stripe_checkout_session_id: string | null;
  stripe_invoice_id: string | null;
  amount_total: number | string | null;
  currency: string | null;
  status: string;
  payment_status: string | null;
  fulfilled_at: string | null;
  created_at: string;
};

function toCheckoutConfigError(message: string) {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message,
  });
}

function assertPaymentPersistenceConfigured(hasSupabaseAdminPrivileges: boolean) {
  if (hasSupabaseAdminPrivileges) {
    return;
  }

  throw toCheckoutConfigError(
    'Stripe checkout requires SUPABASE_SERVICE_ROLE_KEY to persist payment orders and subscriptions'
  );
}

async function loadPaymentItemNames(
  supabase: any,
  orders: Array<{ item_id: string; item_type: string }>
): Promise<{
  creditPackageNames: Map<string, string>;
  membershipPlanNames: Map<string, string>;
}> {
  const creditPackageIds = orders
    .filter((order) => order.item_type === 'credit_package')
    .map((order) => order.item_id);
  const membershipPlanIds = orders
    .filter((order) => order.item_type === 'membership_plan')
    .map((order) => order.item_id);

  const [creditPackagesResult, membershipPlansResult] = await Promise.all([
    creditPackageIds.length > 0
      ? supabase
          .from('credit_packages')
          .select('id, name')
          .in('id', creditPackageIds)
      : Promise.resolve({ data: [], error: null }),
    membershipPlanIds.length > 0
      ? supabase
          .from('membership_plans')
          .select('id, name')
          .in('id', membershipPlanIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (creditPackagesResult.error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: creditPackagesResult.error.message,
    });
  }

  if (membershipPlansResult.error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: membershipPlansResult.error.message,
    });
  }

  return {
    creditPackageNames: new Map<string, string>(
      (creditPackagesResult.data ?? []).map((item: { id: string; name: string }) => [item.id, item.name]),
    ),
    membershipPlanNames: new Map<string, string>(
      (membershipPlansResult.data ?? []).map((item: { id: string; name: string }) => [item.id, item.name]),
    ),
  };
}

async function loadStripeBillingDocument(stripe: ReturnType<typeof getStripeClient> | null, order: any) {
  if (!stripe) {
    return {
      invoiceNumber: null,
      invoicePdfUrl: null,
      hostedInvoiceUrl: null,
      receiptUrl: null,
    };
  }

  if (order.stripe_invoice_id) {
    const invoice = await stripe.invoices.retrieve(order.stripe_invoice_id);
    return {
      invoiceNumber: invoice.number ?? null,
      invoicePdfUrl: invoice.invoice_pdf ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      receiptUrl: null,
    };
  }

  if (!order.stripe_checkout_session_id) {
    return {
      invoiceNumber: null,
      invoicePdfUrl: null,
      hostedInvoiceUrl: null,
      receiptUrl: null,
    };
  }

  const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id, {
    expand: ['payment_intent.latest_charge'],
  });

  const paymentIntent = typeof session.payment_intent === 'object'
    ? session.payment_intent
    : null;
  const latestCharge = paymentIntent?.latest_charge;
  const receiptUrl =
    latestCharge && typeof latestCharge === 'object' && 'receipt_url' in latestCharge
      ? latestCharge.receipt_url ?? null
      : null;

  return {
    invoiceNumber: null,
    invoicePdfUrl: null,
    hostedInvoiceUrl: null,
    receiptUrl,
  };
}

export const paymentsRouter = router({
  createCheckoutSession: protectedProcedure
    .input(createCheckoutInput)
    .mutation(async ({ ctx, input }) => {
      assertPaymentPersistenceConfigured(ctx.hasSupabaseAdminPrivileges);
      let stripe;
      try {
        assertStripeCheckoutConfigured();
        stripe = getStripeClient();
      } catch (error) {
        throw toCheckoutConfigError(
          error instanceof Error ? error.message : 'Stripe checkout is not configured',
        );
      }

      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('email, nickname, membership_level')
        .eq('id', ctx.profileId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '用户资料不存在，无法创建支付会话',
        });
      }

      const customerId = await getOrCreateStripeCustomerId({
        supabase: ctx.supabase,
        userId: ctx.profileId,
        email: profile.email ?? ctx.user.email ?? null,
        nickname: profile.nickname ?? null,
      });

      const appUrl = getStripeAppUrl(ctx.headers);
      const successUrl = `${appUrl}/profile?tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${appUrl}/profile?tab=subscription&checkout=cancelled`;

      if (input.kind === 'credit_package') {
        const [{ data: creditPackage, error }, { data: membershipPlan, error: membershipPlanError }] =
          await Promise.all([
            ctx.supabase
              .from('credit_packages')
              .select('id, name, active, stripe_price_id, price')
              .eq('id', input.packageId)
              .single(),
            profile.membership_level && profile.membership_level !== 'free'
              ? ctx.supabase
                  .from('membership_plans')
                  .select('id, level, package_discount')
                  .eq('level', profile.membership_level)
                  .eq('is_active', 'true')
                  .limit(1)
                  .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
          ]);

        if (error || !creditPackage) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '积分包不存在',
          });
        }

        if (membershipPlanError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: membershipPlanError.message,
          });
        }

        if (creditPackage.active !== 'true') {
          throw toCheckoutConfigError('该积分包当前未上架');
        }

        if (!creditPackage.stripe_price_id) {
          throw toCheckoutConfigError('该积分包尚未配置 Stripe Price ID');
        }

        const { baseAmountCents, discountedAmountCents, normalizedDiscount } =
          calculateDiscountedAmountCents({
            amountCents: creditPackage.price,
            packageDiscount: membershipPlan?.package_discount,
          });

        if (discountedAmountCents <= 0) {
          throw toCheckoutConfigError('该积分包折后金额无效，请先调整会员折扣配置');
        }

        const metadata = {
          ...buildStripeMetadata({
            itemType: 'credit_package',
            itemId: creditPackage.id,
            userId: ctx.profileId,
            priceId: creditPackage.stripe_price_id,
            billingCycle: 'one_time',
          }),
          membershipLevel: profile.membership_level ?? 'free',
          packageDiscount: String(normalizedDiscount),
          basePriceCents: String(baseAmountCents),
          discountedPriceCents: String(discountedAmountCents),
        };

        const lineItems =
          discountedAmountCents === baseAmountCents
            ? [
                {
                  price: creditPackage.stripe_price_id,
                  quantity: 1,
                },
              ]
            : [
                {
                  price_data: {
                    currency: 'usd',
                    unit_amount: discountedAmountCents,
                    product_data: {
                      name: creditPackage.name,
                    },
                  },
                  quantity: 1,
                },
              ];

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer: customerId,
          client_reference_id: ctx.profileId,
          line_items: lineItems,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata,
        });

        const { error: orderError } = await ctx.supabaseAdmin.from('payment_orders').insert({
          user_id: ctx.profileId,
          item_type: 'credit_package',
          item_id: creditPackage.id,
          billing_cycle: 'one_time',
          stripe_checkout_session_id: session.id,
          stripe_customer_id: customerId,
          stripe_price_id: creditPackage.stripe_price_id,
          amount_total: discountedAmountCents,
          currency: 'usd',
          mode: 'payment',
          status: 'pending',
          payment_status: session.payment_status,
          metadata,
        });

        if (orderError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: orderError.message,
          });
        }

        if (!session.url) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Stripe 未返回可跳转的支付链接',
          });
        }

        return {
          checkoutUrl: session.url,
          sessionId: session.id,
        };
      }

      const { data: plan, error } = await ctx.supabase
        .from('membership_plans')
        .select('id, name, level, is_active, stripe_monthly_price_id, stripe_yearly_price_id, monthly_price, yearly_price')
        .eq('id', input.planId)
        .single();

      if (error || !plan) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '会员套餐不存在',
        });
      }

      if (plan.is_active !== 'true') {
        throw toCheckoutConfigError('该会员套餐当前未启用');
      }

      if (plan.level === 'free') {
        throw toCheckoutConfigError('免费套餐无需创建支付会话');
      }

      const selectedPriceId =
        input.billingCycle === 'monthly'
          ? plan.stripe_monthly_price_id
          : plan.stripe_yearly_price_id;

      if (!selectedPriceId) {
        throw toCheckoutConfigError(
          input.billingCycle === 'monthly'
            ? '该会员套餐尚未配置月付 Stripe Price ID'
            : '该会员套餐尚未配置年付 Stripe Price ID'
        );
      }

      const metadata = buildStripeMetadata({
        itemType: 'membership_plan',
        itemId: plan.id,
        userId: ctx.profileId,
        priceId: selectedPriceId,
        billingCycle: input.billingCycle,
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: ctx.profileId,
        line_items: [
          {
            price: selectedPriceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        subscription_data: {
          metadata,
        },
      });

      const { error: orderError } = await ctx.supabaseAdmin.from('payment_orders').insert({
        user_id: ctx.profileId,
        item_type: 'membership_plan',
        item_id: plan.id,
        billing_cycle: input.billingCycle,
        stripe_checkout_session_id: session.id,
        stripe_customer_id: customerId,
        stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : null,
        stripe_price_id: selectedPriceId,
        amount_total: input.billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price,
        currency: 'usd',
        mode: 'subscription',
        status: 'pending',
        payment_status: session.payment_status,
        metadata,
      });

      if (orderError) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: orderError.message,
        });
      }

      if (!session.url) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Stripe 未返回可跳转的支付链接',
        });
      }

      return {
        checkoutUrl: session.url,
        sessionId: session.id,
      };
    }),
  syncCheckoutSession: protectedProcedure
    .input(syncCheckoutInput)
    .mutation(async ({ ctx, input }) => {
      assertPaymentPersistenceConfigured(ctx.hasSupabaseAdminPrivileges);
      try {
        assertStripeCheckoutConfigured();
      } catch (error) {
        throw toCheckoutConfigError(
          error instanceof Error ? error.message : 'Stripe checkout is not configured',
        );
      }

      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(input.sessionId, {
        expand: ['payment_intent', 'subscription', 'invoice'],
      });

      const sessionUserId =
        session.metadata?.userId ??
        session.client_reference_id ??
        null;

      if (sessionUserId !== ctx.profileId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '你无权同步这笔支付会话',
        });
      }

      await upsertPaymentOrderBySession(ctx.supabaseAdmin, session);

      if (session.mode === 'payment' && session.payment_status === 'paid') {
        await fulfillCreditPackageOrder(ctx.supabaseAdmin, session);
      }

      if (session.mode === 'subscription') {
        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id ?? null;

        if (subscriptionId) {
          const subscription =
            typeof session.subscription === 'string'
              ? await stripe.subscriptions.retrieve(subscriptionId)
              : session.subscription;

          if (!subscription) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Stripe 订阅状态不可用，请稍后重试',
            });
          }

          await syncSubscriptionState(ctx.supabaseAdmin, subscription);

          const expandedInvoice =
            typeof session.invoice === 'string'
              ? await stripe.invoices.retrieve(session.invoice)
              : session.invoice ?? null;

          const paidInvoice = expandedInvoice?.status === 'paid'
            ? expandedInvoice
            : (await stripe.invoices.list({
                subscription: subscriptionId,
                limit: 10,
              })).data.find((invoice) => invoice.status === 'paid') ?? null;

          if (paidInvoice) {
            await fulfillMembershipInvoice(ctx.supabaseAdmin, paidInvoice);
          }
        }
      }

      const { data: syncedOrder, error: syncedOrderError } = await ctx.supabaseAdmin
        .from('payment_orders')
        .select('status, payment_status, fulfilled_at, stripe_subscription_id, stripe_invoice_id')
        .eq('stripe_checkout_session_id', session.id)
        .maybeSingle();

      if (syncedOrderError) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: syncedOrderError.message,
        });
      }

      return {
        sessionId: session.id,
        mode: session.mode,
        checkoutStatus: session.status,
        paymentStatus: session.payment_status,
        orderStatus: syncedOrder?.status ?? null,
        fulfilledAt: syncedOrder?.fulfilled_at ?? null,
        stripeSubscriptionId: syncedOrder?.stripe_subscription_id ?? null,
        stripeInvoiceId: syncedOrder?.stripe_invoice_id ?? null,
      };
    }),
  listBillingRecords: protectedProcedure
    .query(async ({ ctx }) => {
      const { data: orders, error } = await ctx.supabase
        .from('payment_orders')
        .select([
          'id',
          'item_id',
          'item_type',
          'billing_cycle',
          'stripe_checkout_session_id',
          'stripe_invoice_id',
          'amount_total',
          'currency',
          'status',
          'payment_status',
          'fulfilled_at',
          'created_at',
        ].join(','))
        .eq('user_id', ctx.profileId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error.message,
        });
      }

      const billingOrders = (orders ?? []) as unknown as PaymentOrderBillingRow[];

      const rawOrders = billingOrders.filter((order) => {
        if (order.item_type === 'membership_plan') {
          return Boolean(order.stripe_invoice_id);
        }

        return Boolean(order.fulfilled_at) || order.payment_status === 'paid' || order.status === 'completed';
      });

      const { creditPackageNames, membershipPlanNames } = await loadPaymentItemNames(ctx.supabase, rawOrders);
      let stripe: ReturnType<typeof getStripeClient> | null = null;

      try {
        stripe = getStripeClient();
      } catch {
        stripe = null;
      }

      const records = await Promise.all(
        rawOrders.map(async (order): Promise<BillingRecord> => {
          const stripeDocuments = await loadStripeBillingDocument(stripe, order);
          const itemType: BillingRecord['itemType'] =
            order.item_type === 'membership_plan' ? 'membership_plan' : 'credit_package';
          const title: string = itemType === 'membership_plan'
            ? membershipPlanNames.get(order.item_id) ?? '会员订阅'
            : creditPackageNames.get(order.item_id) ?? '积分加油包';
          const billingCycle: BillingRecord['billingCycle'] = order.billing_cycle ?? 'one_time';

          return {
            id: order.id,
            itemType,
            title,
            description:
              itemType === 'membership_plan'
                ? `订阅账单 · ${billingCycle === 'yearly' ? '年付' : '月付'}`
                : '一次性积分购买',
            status: order.status,
            amountTotal: Number(order.amount_total ?? 0) / 100,
            currency: order.currency ?? 'usd',
            billingCycle,
            createdAt: order.created_at,
            fulfilledAt: order.fulfilled_at,
            invoiceNumber: stripeDocuments.invoiceNumber,
            invoicePdfUrl: stripeDocuments.invoicePdfUrl,
            hostedInvoiceUrl: stripeDocuments.hostedInvoiceUrl,
            receiptUrl: stripeDocuments.receiptUrl,
          };
        }),
      );

      return records;
    }),
});
