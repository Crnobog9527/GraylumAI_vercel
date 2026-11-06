/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, adminProcedure } from '../trpc';
import { absentRefundCalls, turnModelReport, unsettledTurns } from '../services/turn/settings/turnCostReport';
import { refundStuckTurn, StuckTurnRefundError } from '../services/turn/settings/turnStuckRefund';

import {
  absorbConfigSchema, absorbAckInput, readAbsorbConfig, saveAbsorbConfig,
  readAbsorbAlerts, acknowledgeAbsorb,
} from '../services/bill2PlatformAlerts';

const DAY_MS = 24 * 60 * 60 * 1000;

// Admin-only finance views on the core-path tables (turns, turn_calls): cost per model and the turns still open or settling.
export const billingReportRouter = router({
  platformAbsorbConfig: adminProcedure.query(({ ctx }) => readAbsorbConfig(ctx.supabase)),
  savePlatformAbsorbConfig: adminProcedure.input(absorbConfigSchema)
    .mutation(({ ctx, input }) => saveAbsorbConfig(ctx.supabase, input)),
  platformAbsorbAlerts: adminProcedure.query(({ ctx }) => readAbsorbAlerts(ctx.supabase)),
  acknowledgePlatformAbsorb: adminProcedure.input(absorbAckInput)
    .mutation(({ ctx, input }) => acknowledgeAbsorb(ctx.supabase, input)),
  turnByModel: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }).strict().default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const to = new Date();
      const from = new Date(to.getTime() - input.days * DAY_MS);
      return turnModelReport(ctx.supabase, from, to);
    }),
  // Read-only: turns recovery has not closed or settled yet (content-free). Replaces the old stuck PAYG calls list.
  unsettledTurns: adminProcedure.query(({ ctx }) => unsettledTurns(ctx.supabase)),
  // Read-only: calls settled at zero because the provider said "no such generation" (Owner 2026-11-03); each refund stays on record.
  absentRefunds: adminProcedure.query(({ ctx }) => absentRefundCalls(ctx.supabase)),
  // RECONCILE (b): "按回合全额退回并关闭" for a turn whose freeze can stay for ever (open or undecided for 24 hours or more). Idempotent: a
  // settled turn answers `refunded: false` and changes nothing; a younger one is refused. The database function checks the admin again.
  refundStuckTurn: adminProcedure
    .input(z.object({ actorId: z.string().uuid(), turnId: z.number().int().positive(), reason: z.string().trim().max(200).optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await refundStuckTurn(ctx.supabase, { actorId: input.actorId, turnId: input.turnId, adminId: ctx.user.id,
          requestId: randomUUID(), reason: input.reason });
        if (!result.refunded && result.reason === 'too_young') throw new TRPCError({ code: 'BAD_REQUEST', message: 'TURN_TOO_YOUNG' });
        if (!result.refunded && result.reason === 'not_pending') throw new TRPCError({ code: 'CONFLICT', message: 'TURN_NOT_PENDING' });
        return result;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof StuckTurnRefundError) {
          const denied = error.code === 'TURN_DENIED' || error.code === 'TURN_ADMIN_DENIED';
          throw new TRPCError({ code: denied ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR', message: error.code });
        }
        throw error;
      }
    }),
});
