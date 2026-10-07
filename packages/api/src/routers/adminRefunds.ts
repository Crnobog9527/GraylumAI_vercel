/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { adminProcedure } from '../trpc';
import { createSafeInternalError } from '../lib/publicError';
import { getStripeClient } from '../services/stripe';
import { previewSubscriptionRefund } from '../services/payments/subscriptionRefundPreview';
import {
  previewPackageRefund, decidePackageRefund, executePackageRefund, reconcilePackageRefund, rejectPackageRefund, readPackageRefundStatus,
} from '../services/payments/packageRefund';

const request = z.object({ orderId: z.string().uuid(), ticketId: z.string().uuid(),
  feePermitted: z.enum(['confirmed', 'not_permitted']), feeEvidence: z.string().trim().min(1).max(160) }).strict();
async function safe<T>(action: () => Promise<T>) {
  try { return await action(); } catch (error) {
    throw createSafeInternalError(error, '退款证据不足或状态已变化，请重新核对订单与工单');
  }
}
export const adminRefundProcedures = {
  previewSubscriptionRefund: adminProcedure.input(request.extend({
    feePermitted: z.enum(['confirmed', 'not_permitted', 'unknown']),
  })).query(({ ctx, input }) =>
    safe(() => previewSubscriptionRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input))),
  getPackageRefundStatus: adminProcedure.input(z.object({ orderId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => safe(() => readPackageRefundStatus(ctx.supabaseAdmin, input.orderId))),
  rejectPackageRefund: adminProcedure.input(z.object({ orderId: z.string().uuid(), ticketId: z.string().uuid(),
    reason: z.enum(['ineligible', 'evidence_missing', 'customer_withdrew']),
  }).strict()).mutation(({ ctx, input }) => safe(() => rejectPackageRefund(ctx.supabaseAdmin, ctx.profileId, input))),
  previewPackageRefund: adminProcedure.input(request).query(({ ctx, input }) =>
    safe(() => previewPackageRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input))),
  decidePackageRefund: adminProcedure.input(request.extend({
    versionHash: z.string().regex(/^[a-f0-9]{32}$/), decision: z.enum(['approve', 'reject']),
  })).mutation(({ ctx, input }) =>
    safe(() => decidePackageRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input))),
  executePackageRefund: adminProcedure.input(z.object({
    orderId: z.string().uuid(), intentId: z.string().uuid(),
  }).strict()).mutation(({ ctx, input }) =>
    safe(() => executePackageRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input))),
  reconcilePackageRefund: adminProcedure.input(z.object({ orderId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => safe(() => reconcilePackageRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input.orderId))),
};
