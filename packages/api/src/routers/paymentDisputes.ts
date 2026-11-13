/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { router, adminProcedure, protectedProcedure } from '../trpc';
import { createSafeServiceUnavailableError } from '../lib/publicError';
import { withdrawDisputeHold } from '../services/payments/disputeWithdraw';

export const paymentDisputesRouter = router({
  notice: protectedProcedure.query(async ({ ctx }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_DISPUTE_DB_UNAVAILABLE');
      const rows = await ctx.supabaseAdmin.from('payment_disputes').select('id,lost_confirmed_at,payment_orders!inner(user_id)')
        .eq('payment_orders.user_id', ctx.profileId).eq('freeze_state', 'frozen').limit(50);
      if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_DISPUTE_READ_UNAVAILABLE');
      // CHARGEBACK G1: a confirmed loss is final ("closed"), an unconfirmed hold is still "paused".
      const confirmed = (row: { lost_confirmed_at?: string | null }) => Boolean(row.lost_confirmed_at);
      return { frozen: rows.data.some(row => !confirmed(row)), lost: rows.data.some(confirmed) };
    } catch (error) { throw createSafeServiceUnavailableError(error, '付款状态暂时无法读取'); }
  }),
  list: adminProcedure.input(z.object({ offset: z.number().int().nonnegative().default(0) }).strict().optional())
    .query(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_DISPUTE_DB_UNAVAILABLE');
      const rows = await ctx.supabaseAdmin.from('payment_disputes')
        .select(`id,order_id,provider,provider_dispute_id,merchant_namespace,mode,amount,currency,status,
          freeze_state,renewal_stop_state,evidence_due_by,source_review_required,lost_confirmed_at`)
        .order('opened_at', { ascending: false }).order('id', { ascending: false })
        .range(input?.offset ?? 0, (input?.offset ?? 0) + 99);
      if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_DISPUTE_READ_UNAVAILABLE');
      return rows.data as Array<{ id: string; provider: 'stripe' | 'waffo'; provider_dispute_id: string; merchant_namespace: string; mode: string;
        order_id: string | null; amount: number | null; currency: string | null; status: string;
        freeze_state: string; renewal_stop_state: string; evidence_due_by: string | null; source_review_required: boolean;
        lost_confirmed_at: string | null }>;
    } catch (error) { throw createSafeServiceUnavailableError(error, '拒付记录暂时无法读取'); }
  }),
  resolveExternal: adminProcedure.input(z.object({ disputeId: z.uuid() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_DISPUTE_DB_UNAVAILABLE');
      const result = await ctx.supabaseAdmin.rpc('pay_dispute_resolve_external', { p_actor: ctx.profileId, p_dispute: input.disputeId });
      if (result.error) throw new Error('PAY_DISPUTE_EXTERNAL_UNAVAILABLE');
      return { resolved: true };
    } catch (error) { throw createSafeServiceUnavailableError(error, '未能结案，请核实是否已有对应订单'); }
  }),
  confirmLost: adminProcedure.input(z.object({ disputeId: z.uuid() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_DISPUTE_DB_UNAVAILABLE');
      const result = await ctx.supabaseAdmin.rpc('pay_dispute_confirm_lost', { p_actor: ctx.profileId, p_dispute: input.disputeId });
      if (result.error || !result.data) throw new Error('PAY_DISPUTE_CONFIRM_LOST_UNAVAILABLE');
      return result.data as { duplicate: boolean; confirmedAt: string; heldCredits?: number };
    } catch (error) { throw createSafeServiceUnavailableError(error, '未能结案，请先在原支付渠道核实这笔拒付已判输'); }
  }),
  withdraw: adminProcedure.input(z.object({ disputeId: z.uuid() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      if (!ctx.hasSupabaseAdminPrivileges) throw new Error('PAY_DISPUTE_DB_UNAVAILABLE');
      return await withdrawDisputeHold(ctx.supabaseAdmin, ctx.profileId, input.disputeId);
    } catch (error) { throw createSafeServiceUnavailableError(error, '冻结未撤回，请核对付款和拒付状态后重试'); }
  }),
});
