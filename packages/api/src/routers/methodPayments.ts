/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { assertCheckoutRateLimit, getStripeAppUrl, getStripeClient } from '../services/stripe';
import { methodPurchaseInputSchema } from '../services/payments/methodPurchase';
import { createWalletCheckout } from '../services/payments/walletCheckout';
import { readPaymentMethodRoutes, assertPaymentMethodRoute } from '../services/payments/methodRouting';
import { z } from 'zod';
import { cancelWaffoMembership, controlWaffoProduct } from '../services/payments/waffoOperations';
import { getWaffoTestOperationsClient } from '../services/payments/waffoTestOperationsClient';
import { protectedProcedure, adminProcedure } from '../trpc';
import { createSafeServiceUnavailableError } from '../lib/publicError';
import { METHOD_CHECKOUT_READY, readMethodMembership } from '../services/payments/methodMembership';

export const methodPaymentProcedures = {
  methodCancel: protectedProcedure.input(z.object({ subscriptionId: z.uuid() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      return await cancelWaffoMembership(ctx.supabaseAdmin, getWaffoTestOperationsClient(), ctx.profileId, input.subscriptionId);
    } catch (error) { throw createSafeServiceUnavailableError(error, '停止续费结果待核对，请稍后查看原订阅状态'); }
  }),
  methodProductControl: adminProcedure.input(z.object({ priceRefId: z.uuid(), blocked: z.boolean(),
    expectedVersion: z.number().int().nonnegative().max(9999999999) }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      return await controlWaffoProduct(ctx.supabaseAdmin, getWaffoTestOperationsClient(), { ...input, actorId: ctx.profileId });
    } catch (error) { throw createSafeServiceUnavailableError(error, '产品状态待核对，本站暂停新购期间请勿重复操作'); }
  }),
  methodCheckout: protectedProcedure.input(methodPurchaseInputSchema).mutation(async ({ ctx, input }) => {
    try {
      if (!METHOD_CHECKOUT_READY) throw new Error('PAY_WAFFO_STEP2_NOT_READY');
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
      const routes = await readPaymentMethodRoutes(ctx.supabaseAdmin);
      assertPaymentMethodRoute({ routes, expectedVersion: input.routingVersion, method: input.method,
        annual: input.billingCycle === 'yearly', itemType: input.itemType, paymentMode: 'test' });
      const terms = await ctx.supabaseAdmin.from('system_settings').select('value').eq('key', 'payment_terms_version').maybeSingle();
      if (terms.error || typeof terms.data?.value?.version !== 'string' || input.termsVersion !== terms.data.value.version) {
        throw new Error('PAY_WAFFO_TERMS_UNAVAILABLE');
      }
      await assertCheckoutRateLimit(ctx.profileId, ctx.headers);
      return await createWalletCheckout({ db: ctx.supabaseAdmin, stripe: getStripeClient(), userId: ctx.profileId,
        appUrl: getStripeAppUrl(), termsVersion: terms.data.value.version, purchase: input });
    } catch (error) { throw createSafeServiceUnavailableError(error, '暂时无法创建付款，请稍后查看原订单状态'); }
  }),
  methodMembership: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.hasSupabaseAdminPrivileges) throw createSafeServiceUnavailableError(
      new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE'), '会员状态暂不可用，请稍后重试',
    );
    try { return await readMethodMembership(ctx.supabaseAdmin, ctx.profileId); }
    catch (error) { throw createSafeServiceUnavailableError(error, '会员状态暂不可用，请稍后重试'); }
  }),
};
