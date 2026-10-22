/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminProcedure } from '../trpc';
import { createSafeInternalError, createSafeServiceUnavailableError } from '../lib/publicError';
import { PAYMENT_METHOD_ROUTES_KEY, paymentMethodRoutesSchema, readPaymentMethodRoutes, newPurchaseChannel }
  from '../services/payments/methodRouting';

export const setPaymentFailover = adminProcedure.input(z.object({
  expectedVersion: z.number().int().positive().max(9999999999), channel: z.enum(['stripe', 'waffo']),
}).strict()).mutation(async ({ ctx, input }) => {
  if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '渠道切换暂不可用' });
  const { data, error } = await ctx.supabaseAdmin.rpc('pay_failover_set_channel', {
    p_actor: ctx.profileId, p_version: input.expectedVersion, p_channel: input.channel,
  });
  if (error?.code === 'PT409' || error?.code === '40001') {
    throw new TRPCError({ code: 'CONFLICT', message: '渠道已变化，请刷新后核对' });
  }
  if (error) throw createSafeInternalError(error, '新购买渠道切换失败，请刷新后核对');
  return paymentMethodRoutesSchema.parse(data);
});

/** Generic settings saves can retain the channel; only the dedicated RPC changes it and writes its audit. */
export async function assertNoFailoverChange(client: SupabaseClient, input: Array<{ key: string; value: unknown }>) {
  for (const item of input.filter(item => item.key === PAYMENT_METHOD_ROUTES_KEY)) {
    const current = await readPaymentMethodRoutes(client).catch(error => {
      throw createSafeServiceUnavailableError(error, '付款渠道暂时无法核对，请刷新后重试');
    });
    if (newPurchaseChannel(paymentMethodRoutesSchema.parse(item.value)) !== newPurchaseChannel(current)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '新购买渠道请通过应急切换按钮修改' });
    }
  }
}
