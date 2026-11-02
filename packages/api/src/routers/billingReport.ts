/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { router, adminProcedure } from '../trpc';
import { turnModelReport, unsettledTurns } from '../services/turn/settings/turnCostReport';

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
});
