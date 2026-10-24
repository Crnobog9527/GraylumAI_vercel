/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { adminProcedure } from '../trpc';
import { createSafeInternalError } from '../lib/publicError';
import { packageRefundQuoteError } from '../services/payments/packageRefundError';
import { monthlyRefundError } from '../services/payments/monthlyRefundError';
import { getStripeClient } from '../services/stripe';
import { quoteMonthlyRefund, approveMonthlyRefund, executeMonthlyRefund, monthlyRefundStatus, rejectMonthlyRefund }
  from '../services/payments/monthlyRefundService';
import { previewSubscriptionRefund } from '../services/payments/subscriptionRefundPreview';
import {
  previewPackageRefund, decidePackageRefund, executePackageRefund, reconcilePackageRefund, rejectPackageRefund, readPackageRefundStatus,
} from '../services/payments/packageRefund';

import { dispatchOrderRefund } from '../services/payments/refundDispatch';
import { resolveTicketNumber, ticketNumberInput } from '../services/payments/ticketReference';
import { previewWaffoRefund, decideWaffoRefund, executeWaffoRefund, reconcileWaffoRefund }
  from '../services/payments/waffoRefund';

const request = z.object({ orderId: z.string().uuid(), ticketId: z.string().uuid(),
  feePermitted: z.enum(['confirmed', 'not_permitted']), feeEvidence: z.string().trim().min(1).max(160) }).strict();
async function safe<T>(action: () => Promise<T>, operation?: 'quote' | 'status' | 'reject' | 'packageQuote') {
  try { return await action(); } catch (error) {
    if (operation === 'packageQuote') throw packageRefundQuoteError(error);
    if (operation) throw monthlyRefundError(error, operation);
    throw createSafeInternalError(error, '退款证据不足或状态已变化，请重新核对订单与工单');
  }
}
const monthlyRequest = request.extend({ feePermitted: z.enum(['confirmed', 'not_permitted', 'unknown']),
  feeEvidence: z.string().regex(/^[A-Za-z0-9:._/-]{1,160}$/) });
const refundProcedures = {
  // Admins see ticket numbers (TK-…); the refund forms turn one into the ticket ID before quoting or rejecting.
  resolveRefundTicket: adminProcedure.input(ticketNumberInput)
    .query(({ ctx, input }) => resolveTicketNumber(ctx.supabaseAdmin, input.ticketNumber)),
  quoteMonthlyRefund: adminProcedure.input(monthlyRequest).query(({ ctx, input }) =>
    safe(() => quoteMonthlyRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input), 'quote')),
  approveMonthlyRefund: adminProcedure.input(monthlyRequest.extend({
    versionHash: z.string().regex(/^[a-f0-9]{64}$/), localVersion: z.string().regex(/^[a-f0-9]{32}$/),
  })).mutation(({ ctx, input }) => safe(() => approveMonthlyRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input))),
  executeMonthlyRefund: adminProcedure.input(z.object({ orderId: z.string().uuid(), intentId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) =>
      safe(() => executeMonthlyRefund(ctx.supabaseAdmin, getStripeClient(), ctx.profileId, input.orderId, input.intentId))),
  rejectMonthlyRefund: adminProcedure.input(z.object({ orderId: z.string().uuid(), ticketId: z.string().uuid(),
    reason: z.enum(['ineligible', 'evidence_missing', 'customer_withdrew']),
  }).strict()).mutation(({ ctx, input }) => safe(() => rejectMonthlyRefund(ctx.supabaseAdmin, ctx.profileId, input), 'reject')),
  getMonthlyRefundStatus: adminProcedure.input(z.object({ orderId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => safe(() => monthlyRefundStatus(ctx.supabaseAdmin, input.orderId), 'status')),
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
    safe(() => dispatchOrderRefund(ctx.supabaseAdmin, input.orderId,
      provider => previewPackageRefund(ctx.supabaseAdmin, provider, ctx.profileId, input),
      provider => previewWaffoRefund(ctx.supabaseAdmin, provider, ctx.profileId, input)), 'packageQuote')),
  decidePackageRefund: adminProcedure.input(request.extend({
    versionHash: z.string().regex(/^[a-f0-9]{32}$/), decision: z.enum(['approve', 'reject']),
  })).mutation(({ ctx, input }) =>
    safe(() => dispatchOrderRefund(ctx.supabaseAdmin, input.orderId,
      provider => decidePackageRefund(ctx.supabaseAdmin, provider, ctx.profileId, input),
      provider => decideWaffoRefund(ctx.supabaseAdmin, provider, ctx.profileId, input)))),
  executePackageRefund: adminProcedure.input(z.object({
    orderId: z.string().uuid(), intentId: z.string().uuid(),
  }).strict()).mutation(({ ctx, input }) =>
    safe(() => dispatchOrderRefund(ctx.supabaseAdmin, input.orderId,
      provider => executePackageRefund(ctx.supabaseAdmin, provider, ctx.profileId, input),
      provider => executeWaffoRefund(ctx.supabaseAdmin, provider, ctx.profileId, input)))),
  reconcilePackageRefund: adminProcedure.input(z.object({ orderId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => safe(() => dispatchOrderRefund(ctx.supabaseAdmin, input.orderId,
      provider => reconcilePackageRefund(ctx.supabaseAdmin, provider, ctx.profileId, input.orderId),
      provider => reconcileWaffoRefund(ctx.supabaseAdmin, provider, ctx.profileId, input.orderId)))),
};

// Stable subscription names for the shared admin UI; legacy monthly routes remain compatible.
export const adminRefundProcedures = {
  ...refundProcedures,
  quoteSubscriptionRefund: refundProcedures.quoteMonthlyRefund,
  approveSubscriptionRefund: refundProcedures.approveMonthlyRefund,
  executeSubscriptionRefund: refundProcedures.executeMonthlyRefund,
  getSubscriptionRefundStatus: refundProcedures.getMonthlyRefundStatus,
  rejectSubscriptionRefund: refundProcedures.rejectMonthlyRefund,
};
