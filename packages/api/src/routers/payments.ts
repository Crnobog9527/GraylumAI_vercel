/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { logger } from '../lib/logger';
import { createSafeInternalError } from '../lib/publicError';
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
import {
  resolveMembershipEligibility,
  type MembershipEligibilityResult,
} from '../services/membershipEligibility';

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

type CreateCheckoutInput = z.infer<typeof createCheckoutInput>;

function maskIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function maskKnownIdentifiers(message: string | null | undefined) {
  if (!message) {
    return null;
  }

  return message
    .replace(
      /\b(?:cs_(?:test|live)|sub|in|cus|price|pi|ch)_[A-Za-z0-9_]+\b/g,
      (value) => maskIdentifier(value) ?? value,
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (value) => maskIdentifier(value) ?? value,
    );
}

function summarizePaymentError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      name: null,
      type: null,
      code: null,
      statusCode: null,
      message: typeof error === 'string' ? maskKnownIdentifiers(error.slice(0, 240)) : null,
    };
  }

  const errorRecord = error as {
    name?: unknown;
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
    stage?: unknown;
    safeContext?: unknown;
    raw?: {
      type?: unknown;
      code?: unknown;
      message?: unknown;
    };
  };

  const rawMessage = typeof errorRecord.raw?.message === 'string'
      ? errorRecord.raw.message
      : typeof errorRecord.message === 'string'
        ? errorRecord.message
        : null;

  return {
    name: typeof errorRecord.name === 'string' ? errorRecord.name : null,
    type: typeof errorRecord.raw?.type === 'string'
      ? errorRecord.raw.type
      : typeof errorRecord.type === 'string'
        ? errorRecord.type
        : null,
    code: typeof errorRecord.raw?.code === 'string'
      ? errorRecord.raw.code
      : typeof errorRecord.code === 'string'
        ? errorRecord.code
        : null,
    statusCode: typeof errorRecord.statusCode === 'number'
      ? errorRecord.statusCode
      : typeof errorRecord.status === 'number'
        ? errorRecord.status
        : null,
    stage: typeof errorRecord.stage === 'string' ? errorRecord.stage : null,
    safeContext: errorRecord.safeContext && typeof errorRecord.safeContext === 'object'
      ? errorRecord.safeContext
      : null,
    message: maskKnownIdentifiers(rawMessage?.slice(0, 240)) ?? null,
  };
}

function getCheckoutItemId(input: CreateCheckoutInput) {
  return input.kind === 'credit_package' ? input.packageId : input.planId;
}

function logCheckoutStageFailure(
  stage: string,
  input: CreateCheckoutInput,
  error: unknown,
  extra: Record<string, unknown> = {},
) {
  logger.error('billing', 'payments_checkout_stage_failed', {
    stage,
    kind: input.kind,
    itemId: getCheckoutItemId(input),
    ...extra,
    error: summarizePaymentError(error),
  });
}

function toCheckoutConfigError(message: string) {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message,
  });
}

function createPaymentOperationError(operation: string, cause: unknown) {
  return createSafeInternalError(cause, `${operation}失败，请稍后重试`);
}

function getCheckoutSessionSubscriptionId(session: any) {
  return typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null;
}

function getCheckoutSessionInvoiceId(session: any) {
  return typeof session.invoice === 'string'
    ? session.invoice
    : session.invoice?.id ?? null;
}

function logSyncCheckoutStage(
  stage: string,
  input: z.infer<typeof syncCheckoutInput>,
  extra: Record<string, unknown> = {},
) {
  logger.info('billing', 'payments_sync_checkout_stage', {
    stage,
    checkoutSessionId: maskIdentifier(input.sessionId),
    ...extra,
  });
}

function logSyncCheckoutStageFailure(
  stage: string,
  input: z.infer<typeof syncCheckoutInput>,
  error: unknown,
  extra: Record<string, unknown> = {},
) {
  logger.error('billing', 'payments_sync_checkout_stage_failed', {
    stage,
    checkoutSessionId: maskIdentifier(input.sessionId),
    ...extra,
    error: summarizePaymentError(error),
  });
}

function toCheckoutUnavailableError() {
  return toCheckoutConfigError('支付暂不可用，请稍后重试');
}

function toItemUnavailableError(message = '该商品暂不可购买，请稍后重试') {
  return toCheckoutConfigError(message);
}

function assertPaymentPersistenceConfigured(hasSupabaseAdminPrivileges: boolean) {
  if (hasSupabaseAdminPrivileges) {
    return;
  }

  throw toCheckoutUnavailableError();
}

function throwMembershipEligibilityError(result: MembershipEligibilityResult): never {
  throw new TRPCError({
    code: result.reasonCode === 'READ_FAILED' ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
    message: result.safeMessage,
  });
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
    throw createPaymentOperationError('读取账单项目', creditPackagesResult.error);
  }

  if (membershipPlansResult.error) {
    throw createPaymentOperationError('读取账单项目', membershipPlansResult.error);
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
  const emptyDocument = {
    invoiceNumber: null,
    invoicePdfUrl: null,
    hostedInvoiceUrl: null,
    receiptUrl: null,
  };

  if (!stripe) {
    return emptyDocument;
  }

  try {
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
      return emptyDocument;
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
  } catch (error) {
    logger.warn('billing', 'payments_billing_document_lookup_failed', {
      orderId: order.id,
      stripeInvoiceId: order.stripe_invoice_id ?? null,
      stripeCheckoutSessionId: order.stripe_checkout_session_id ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      invoiceNumber: null,
      invoicePdfUrl: null,
      hostedInvoiceUrl: null,
      receiptUrl: null,
    };
  }
}

function createStripeBillingDocumentLoader(stripe: ReturnType<typeof getStripeClient> | null) {
  const documentCache = new Map<string, Promise<Awaited<ReturnType<typeof loadStripeBillingDocument>>>>();

  return async (order: any) => {
    const cacheKey = order.stripe_invoice_id
      ? `invoice:${order.stripe_invoice_id}`
      : order.stripe_checkout_session_id
        ? `session:${order.stripe_checkout_session_id}`
        : `order:${order.id}`;

    const cached = documentCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = loadStripeBillingDocument(stripe, order);
    documentCache.set(cacheKey, promise);
    return promise;
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
        logCheckoutStageFailure('stripe_config', input, error);
        throw toCheckoutUnavailableError();
      }

      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('email, nickname, membership_level')
        .eq('id', ctx.profileId)
        .single();

      if (profileError || !profile) {
        if (profileError) {
          logCheckoutStageFailure('profile_read', input, profileError);
        }

        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '用户资料不存在，无法创建支付会话',
        });
      }

      let checkoutContext: {
        customerId: string;
        successUrl: string;
        cancelUrl: string;
      } | null = null;

      const getCheckoutContext = async () => {
        if (checkoutContext) {
          return checkoutContext;
        }

        let customerId;
        try {
          customerId = await getOrCreateStripeCustomerId({
            supabase: ctx.supabaseAdmin,
            userId: ctx.profileId,
            email: profile.email ?? ctx.user.email ?? null,
            nickname: profile.nickname ?? null,
          });
        } catch (error) {
          logCheckoutStageFailure('customer_lookup', input, error);
          throw createPaymentOperationError('创建支付会话', error);
        }

        let appUrl;
        try {
          appUrl = getStripeAppUrl(ctx.headers);
        } catch (error) {
          logCheckoutStageFailure('checkout_url', input, error);
          throw toCheckoutUnavailableError();
        }

        checkoutContext = {
          customerId,
          successUrl: `${appUrl}/profile?tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${appUrl}/profile?tab=subscription&checkout=cancelled`,
        };

        return checkoutContext;
      };

      if (input.kind === 'credit_package') {
        const { data: creditPackage, error } = await ctx.supabase
          .from('credit_packages')
          .select('id, name, active, stripe_price_id, price')
          .eq('id', input.packageId)
          .single();

        if (error || !creditPackage) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '积分包不存在',
          });
        }

        if (creditPackage.active !== 'true') {
          throw toCheckoutConfigError('该积分包当前未上架');
        }

        if (!creditPackage.stripe_price_id) {
          throw toItemUnavailableError();
        }

        const eligibility = await resolveMembershipEligibility({
          supabase: ctx.supabase,
          userId: ctx.profileId,
          profile,
          action: 'create_credit_package_checkout',
        });

        if (!eligibility.allowed) {
          throwMembershipEligibilityError(eligibility);
        }

        const { data: membershipPlan, error: membershipPlanError } =
          eligibility.level !== 'free'
            ? await ctx.supabase
                .from('membership_plans')
                .select('id, level, package_discount')
                .eq('level', eligibility.level)
                .eq('is_active', 'true')
                .limit(1)
                .maybeSingle()
            : { data: null, error: null };

        if (membershipPlanError) {
          logCheckoutStageFailure('plan_discount_read', input, membershipPlanError, {
            priceId: maskIdentifier(creditPackage.stripe_price_id),
            hasPriceId: Boolean(creditPackage.stripe_price_id),
          });
          throw createPaymentOperationError('读取会员折扣', membershipPlanError);
        }

        const { baseAmountCents, discountedAmountCents, normalizedDiscount } =
          calculateDiscountedAmountCents({
            amountCents: creditPackage.price,
            packageDiscount: membershipPlan?.package_discount,
          });

        if (discountedAmountCents <= 0) {
          throw toItemUnavailableError();
        }

        const metadata = {
          ...buildStripeMetadata({
            itemType: 'credit_package',
            itemId: creditPackage.id,
            userId: ctx.profileId,
            priceId: creditPackage.stripe_price_id,
            billingCycle: 'one_time',
          }),
          membershipLevel: eligibility.level,
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

        const checkout = await getCheckoutContext();
        let session;
        try {
          session = await stripe.checkout.sessions.create({
            mode: 'payment',
            customer: checkout.customerId,
            client_reference_id: ctx.profileId,
            line_items: lineItems,
            success_url: checkout.successUrl,
            cancel_url: checkout.cancelUrl,
            metadata,
          });
        } catch (error) {
          logCheckoutStageFailure('stripe_session_create', input, error, {
            priceId: maskIdentifier(creditPackage.stripe_price_id),
            hasPriceId: Boolean(creditPackage.stripe_price_id),
          });
          throw createPaymentOperationError('创建支付会话', error);
        }

        const { error: orderError } = await ctx.supabaseAdmin.from('payment_orders').insert({
          user_id: ctx.profileId,
          item_type: 'credit_package',
          item_id: creditPackage.id,
          billing_cycle: 'one_time',
          stripe_checkout_session_id: session.id,
          stripe_customer_id: checkout.customerId,
          stripe_price_id: creditPackage.stripe_price_id,
          amount_total: discountedAmountCents,
          currency: 'usd',
          mode: 'payment',
          status: 'pending',
          payment_status: session.payment_status,
          metadata,
        });

        if (orderError) {
          logCheckoutStageFailure('order_insert', input, orderError, {
            priceId: maskIdentifier(creditPackage.stripe_price_id),
            hasPriceId: Boolean(creditPackage.stripe_price_id),
          });
          throw createPaymentOperationError('保存支付订单', orderError);
        }

        if (!session.url) {
          throw createPaymentOperationError('创建支付会话', new Error('Stripe checkout URL missing'));
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
        if (error) {
          logCheckoutStageFailure('plan_read', input, error);
        }

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
        throw toItemUnavailableError('该会员套餐暂不可购买，请稍后重试');
      }

      const eligibility = await resolveMembershipEligibility({
        supabase: ctx.supabase,
        userId: ctx.profileId,
        profile,
        action: 'create_membership_checkout',
        targetPlan: plan,
      });

      if (!eligibility.allowed) {
        throwMembershipEligibilityError(eligibility);
      }

      const metadata = buildStripeMetadata({
        itemType: 'membership_plan',
        itemId: plan.id,
        userId: ctx.profileId,
        priceId: selectedPriceId,
        billingCycle: input.billingCycle,
      });

      const checkout = await getCheckoutContext();
      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: checkout.customerId,
          client_reference_id: ctx.profileId,
          line_items: [
            {
              price: selectedPriceId,
              quantity: 1,
            },
          ],
          success_url: checkout.successUrl,
          cancel_url: checkout.cancelUrl,
          metadata,
          subscription_data: {
            metadata,
          },
        });
      } catch (error) {
        logCheckoutStageFailure('stripe_session_create', input, error, {
          priceId: maskIdentifier(selectedPriceId),
          hasPriceId: Boolean(selectedPriceId),
        });
        throw createPaymentOperationError('创建支付会话', error);
      }

      const { error: orderError } = await ctx.supabaseAdmin.from('payment_orders').insert({
        user_id: ctx.profileId,
        item_type: 'membership_plan',
        item_id: plan.id,
        billing_cycle: input.billingCycle,
        stripe_checkout_session_id: session.id,
        stripe_customer_id: checkout.customerId,
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
        logCheckoutStageFailure('order_insert', input, orderError, {
          priceId: maskIdentifier(selectedPriceId),
          hasPriceId: Boolean(selectedPriceId),
        });
        throw createPaymentOperationError('保存支付订单', orderError);
      }

      if (!session.url) {
        throw createPaymentOperationError('创建支付会话', new Error('Stripe checkout URL missing'));
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
        logSyncCheckoutStageFailure('stripe_config', input, error);
        throw toCheckoutUnavailableError();
      }

      const stripe = getStripeClient();
      let session;
      try {
        logSyncCheckoutStage('session_retrieve_start', input, {
          profileId: maskIdentifier(ctx.profileId),
        });
        session = await stripe.checkout.sessions.retrieve(input.sessionId, {
          expand: ['payment_intent', 'subscription', 'invoice'],
        });
        logSyncCheckoutStage('session_retrieve', input, {
          profileId: maskIdentifier(ctx.profileId),
          mode: session.mode,
          checkoutStatus: session.status,
          paymentStatus: session.payment_status,
          subscriptionId: maskIdentifier(getCheckoutSessionSubscriptionId(session)),
          invoiceId: maskIdentifier(getCheckoutSessionInvoiceId(session)),
        });
      } catch (error) {
        logSyncCheckoutStageFailure('session_retrieve', input, error, {
          profileId: maskIdentifier(ctx.profileId),
        });
        throw createPaymentOperationError('同步支付会话', error);
      }

      const sessionUserId =
        session.metadata?.userId ??
        session.client_reference_id ??
        null;

      if (sessionUserId !== ctx.profileId) {
        logSyncCheckoutStageFailure('session_owner_check', input, new Error('checkout session owner mismatch'), {
          profileId: maskIdentifier(ctx.profileId),
          sessionUserId: maskIdentifier(sessionUserId),
        });
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '你无权同步这笔支付会话',
        });
      }

      let syncStage = 'upsert_payment_order';
      let syncStageContext: Record<string, unknown> = {
        profileId: maskIdentifier(ctx.profileId),
        mode: session.mode,
        checkoutStatus: session.status,
        paymentStatus: session.payment_status,
        subscriptionId: maskIdentifier(getCheckoutSessionSubscriptionId(session)),
        invoiceId: maskIdentifier(getCheckoutSessionInvoiceId(session)),
      };

      try {
        logSyncCheckoutStage(syncStage, input, syncStageContext);
        await upsertPaymentOrderBySession(ctx.supabaseAdmin, session);

        if (session.mode === 'payment' && session.payment_status === 'paid') {
          syncStage = 'fulfill_credit_package';
          logSyncCheckoutStage(syncStage, input, syncStageContext);
          await fulfillCreditPackageOrder(ctx.supabaseAdmin, session);
        }

        if (session.mode === 'subscription') {
          const subscriptionId = getCheckoutSessionSubscriptionId(session);

          if (subscriptionId) {
            syncStageContext = {
              ...syncStageContext,
              subscriptionId: maskIdentifier(subscriptionId),
            };
            syncStage = 'subscription_retrieve';
            logSyncCheckoutStage(syncStage, input, syncStageContext);
            const subscription =
              typeof session.subscription === 'string'
                ? await stripe.subscriptions.retrieve(subscriptionId)
                : session.subscription;

            if (!subscription) {
              throw new Error('Stripe subscription unavailable');
            }

            syncStage = 'sync_subscription_state';
            logSyncCheckoutStage(syncStage, input, {
              ...syncStageContext,
              subscriptionStatus: subscription.status,
            });
            await syncSubscriptionState(ctx.supabaseAdmin, subscription);

            syncStage = 'invoice_lookup';
            logSyncCheckoutStage(syncStage, input, syncStageContext);
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
              syncStage = 'fulfill_membership_invoice';
              syncStageContext = {
                ...syncStageContext,
                invoiceId: maskIdentifier(paidInvoice.id),
                invoiceStatus: paidInvoice.status ?? null,
              };
              logSyncCheckoutStage(syncStage, input, syncStageContext);
              await fulfillMembershipInvoice(ctx.supabaseAdmin, paidInvoice);
            } else {
              logger.warn('billing', 'payments_sync_checkout_no_paid_invoice', {
                stage: syncStage,
                checkoutSessionId: maskIdentifier(input.sessionId),
                subscriptionId: maskIdentifier(subscriptionId),
                expandedInvoiceId: maskIdentifier(expandedInvoice?.id),
                expandedInvoiceStatus: expandedInvoice?.status ?? null,
              });
            }
          } else {
            logger.warn('billing', 'payments_sync_checkout_missing_subscription', {
              stage: 'subscription_id_parse',
              checkoutSessionId: maskIdentifier(input.sessionId),
              mode: session.mode,
              paymentStatus: session.payment_status,
            });
          }
        }
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        logSyncCheckoutStageFailure(syncStage, input, error, syncStageContext);
        throw createPaymentOperationError('同步支付会话', error);
      }

      const { data: syncedOrder, error: syncedOrderError } = await ctx.supabaseAdmin
        .from('payment_orders')
        .select('status, payment_status, fulfilled_at, stripe_subscription_id, stripe_invoice_id')
        .eq('stripe_checkout_session_id', session.id)
        .maybeSingle();

      if (syncedOrderError) {
        logSyncCheckoutStageFailure('final_order_read', input, syncedOrderError, {
          profileId: maskIdentifier(ctx.profileId),
        });
        throw createPaymentOperationError('读取支付同步结果', syncedOrderError);
      }

      logSyncCheckoutStage('final_order_read', input, {
        profileId: maskIdentifier(ctx.profileId),
        orderStatus: syncedOrder?.status ?? null,
        paymentStatus: syncedOrder?.payment_status ?? null,
        fulfilledAt: syncedOrder?.fulfilled_at ?? null,
        subscriptionId: maskIdentifier(syncedOrder?.stripe_subscription_id),
        invoiceId: maskIdentifier(syncedOrder?.stripe_invoice_id),
      });

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
        throw createPaymentOperationError('读取账单记录', error);
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
      const loadBillingDocument = createStripeBillingDocumentLoader(stripe);

      let records;
      try {
        records = await Promise.all(
          rawOrders.map(async (order): Promise<BillingRecord> => {
            const stripeDocuments = await loadBillingDocument(order);
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
      } catch (error) {
        throw createPaymentOperationError('读取账单记录', error);
      }

      return records;
    }),
});
