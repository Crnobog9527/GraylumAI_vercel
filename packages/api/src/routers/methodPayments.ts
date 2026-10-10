/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { protectedProcedure } from '../trpc';
import { createSafeServiceUnavailableError } from '../lib/publicError';
import { readMethodMembership } from '../services/payments/methodMembership';

export const methodPaymentProcedures = {
  methodMembership: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.hasSupabaseAdminPrivileges) throw createSafeServiceUnavailableError(
      new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE'), '会员状态暂不可用，请稍后重试',
    );
    try { return await readMethodMembership(ctx.supabaseAdmin, ctx.profileId); }
    catch (error) { throw createSafeServiceUnavailableError(error, '会员状态暂不可用，请稍后重试'); }
  }),
};
