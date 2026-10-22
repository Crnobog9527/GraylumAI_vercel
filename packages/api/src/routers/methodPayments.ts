import { observeFailoverUpgrade } from '../services/payments/failoverAfterFulfillment';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { assertCheckoutRateLimit, getStripeAppUrl, getStripeClient } from '../services/stripe';
import { methodCheckoutInputSchema } from '../services/payments/methodPurchase';
import { checkoutValue, storeGaCheckoutIds } from '../services/analytics/gaPurchase';
import { createWalletCheckout } from '../services/payments/walletCheckout';
import { createStripeCardCheckout } from '../services/payments/stripeMethodCheckout';
import { readPaymentMethodRoutes, assertPaymentMethodRoute, isCardMethod } from '../services/payments/methodRouting';
import { z } from 'zod';
import { cancelWaffoMembership, controlWaffoProduct } from '../services/payments/waffoOperations';
import { getWaffoTestOperationsClient, getWaffoOperationsClient } from '../services/payments/waffoTestOperationsClient';
import { protectedProcedure, adminProcedure } from '../trpc';
import { createSafeServiceUnavailableError } from '../lib/publicError';
import { RateLimitError } from '../lib/rateLimitError';
import { readMethodMembership } from '../services/payments/methodMembership';
import { createWaffoOneTimeCheckout } from '../services/payments/waffoOneTimeCheckout';
import { assertMethodCheckoutEnvironment, assertWaffoCheckoutEnvironment, paymentDeploymentMode } from '../services/payments/methodCheckoutGate';
import { describeWaffoFailure } from '../services/payments/waffoFailure';
import { hasUnpaidSubscription, mapMethodPurchaseRejection, MethodPurchaseRejected } from '../services/payments/methodPurchaseError';
import { logger } from '../lib/logger';

/** The client only sees a generic 503; this keeps the secret-free reason (#815 checkout had none).
 * Categorised provider/key/database failures are errors; expected gates (closed switch, stale route) are warnings. */
function logMethodPaymentFailure(operation: string, userId: string, error: unknown, context: Record<string, unknown> = {}) {
  const reason = describeWaffoFailure(error);
  logger[reason.category ? 'error' : 'warn']('billing', 'pay_waffo_method_failed', { operation, userId, ...context, ...reason });
}

export const methodPaymentProcedures = {
  methodCancel: protectedProcedure.input(z.object({ subscriptionId: z.uuid() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      return await cancelWaffoMembership(ctx.supabaseAdmin, getWaffoTestOperationsClient(), ctx.profileId, input.subscriptionId);
    } catch (error) {
      logMethodPaymentFailure('method_cancel', ctx.profileId, error);
      throw createSafeServiceUnavailableError(error, '停止续费结果待核对，请稍后查看原订阅状态');
    }
  }),
  methodProductControl: adminProcedure.input(z.object({ priceRefId: z.uuid(), blocked: z.boolean(),
    expectedVersion: z.number().int().nonnegative().max(9999999999) }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      return await controlWaffoProduct(ctx.supabaseAdmin, getWaffoTestOperationsClient(), { ...input, actorId: ctx.profileId });
    } catch (error) {
      logMethodPaymentFailure('method_product_control', ctx.profileId, error);
      throw createSafeServiceUnavailableError(error, '产品状态待核对，本站暂停新购期间请勿重复操作');
    }
  }),
  methodCheckout: protectedProcedure.input(methodCheckoutInputSchema).mutation(async ({ ctx, input: request }) => {
    // GA ids never reach the purchase (checkout_request, Stripe metadata); they are kept beside the order.
    const { analytics, stripeTestClockCustomerId, ...input } = request;
    // Stamped before the provider is called: ids are refused if consent was withdrawn after this moment.
    const requestedAt = new Date();
    try {
      // Staging card test only; card/card_cn.enabled in the versioned routes is the default-off switch below.
      assertMethodCheckoutEnvironment(process.env, input.method, undefined, Boolean(stripeTestClockCustomerId));
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      const routes = await readPaymentMethodRoutes(ctx.supabaseAdmin);
      const route = assertPaymentMethodRoute({ routes, expectedVersion: input.routingVersion, method: input.method,
        annual: input.billingCycle === 'yearly', itemType: input.itemType });
      if (route.channel === 'waffo') {
        assertWaffoCheckoutEnvironment(process.env, input.method);
        if (stripeTestClockCustomerId) throw new Error('PAY_WAFFO_METHOD_DENIED');
      }
      const terms = await ctx.supabaseAdmin.from('system_settings').select('value').eq('key', 'payment_terms_version').maybeSingle();
      if (terms.error || typeof terms.data?.value?.version !== 'string' || input.termsVersion !== terms.data.value.version) {
        throw new Error('PAY_WAFFO_TERMS_UNAVAILABLE');
      }
      await assertCheckoutRateLimit(ctx.profileId, ctx.headers);
      const common = { db: ctx.supabaseAdmin, userId: ctx.profileId, appUrl: getStripeAppUrl(),
        termsVersion: terms.data.value.version, purchase: input };
      if (route.channel === 'waffo' && input.transition === 'upgrade') {
        await observeFailoverUpgrade(ctx.supabaseAdmin, ctx.profileId, input.priorSubscriptionId);
      }
      // Resolve only the chosen provider. A Stripe risk outage cannot prevent Waffo checkout.
      const result = route.channel === 'waffo'
        ? await createWaffoOneTimeCheckout({ ...common, provider: getWaffoOperationsClient(paymentDeploymentMode()),
          checkoutOrigin: 'https://pancake.waffo.ai' })
        : await (isCardMethod(input.method)
          ? createStripeCardCheckout({ ...common, stripe: getStripeClient(), stripeTestClockCustomerId })
          : createWalletCheckout({ ...common, stripe: getStripeClient() }));
      if (result.state !== 'open') return result;
      if (analytics !== undefined) await storeGaCheckoutIds(ctx.supabaseAdmin, ctx.profileId, result.orderId, analytics, requestedAt);
      // The order's pre-tax amount for the browser's begin_checkout (statistics only; null when unreadable).
      return { ...result, checkoutValue: await checkoutValue(ctx.supabaseAdmin, ctx.profileId, result.orderId) };
    } catch (error) {
      logMethodPaymentFailure('method_checkout', ctx.profileId, error, { method: input.method });
      // A throttled buyer gets TOO_MANY_REQUESTS with its retry hint, which the purchase page shows as such.
      if (error instanceof RateLimitError) throw error;
      const unpaidSubscription = error instanceof MethodPurchaseRejected && error.message === 'PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED'
        && ctx.hasSupabaseAdminPrivileges && await hasUnpaidSubscription(ctx.supabaseAdmin, ctx.profileId);
      throw mapMethodPurchaseRejection(error, { unpaidSubscription })
        ?? createSafeServiceUnavailableError(error, '暂时无法创建付款，请稍后查看原订单状态');
    }
  }),
  methodMembership: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.hasSupabaseAdminPrivileges) throw createSafeServiceUnavailableError(
      new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE'), '会员状态暂不可用，请稍后重试',
    );
    try {
      const mode = paymentDeploymentMode();
      return await readMethodMembership(ctx.supabaseAdmin, ctx.profileId, Date.now(), process.env, mode);
    }
    catch (error) { throw createSafeServiceUnavailableError(error, '会员状态暂不可用，请稍后重试'); }
  }),
};
