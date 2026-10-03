/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { router, adminProcedure } from '../trpc';
import { logger } from '../lib/logger';
import { buildBill2ModelReport, type Bill2CallReportRow } from '../services/bill2ModelReport';

import {
  absorbConfigSchema, absorbAckInput, readAbsorbConfig, saveAbsorbConfig,
  readAbsorbAlerts, acknowledgeAbsorb,
} from '../services/bill2PlatformAlerts';

export const BILL2_REPORT_LIMIT = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

// BILL-UNIT: admin-only BILL2 cost per model with frozen multipliers (via bill2_admin_call_report).
export const billingReportRouter = router({
  platformAbsorbConfig: adminProcedure.query(({ ctx }) => readAbsorbConfig(ctx.supabase)),
  savePlatformAbsorbConfig: adminProcedure.input(absorbConfigSchema)
    .mutation(({ ctx, input }) => saveAbsorbConfig(ctx.supabase, input)),
  platformAbsorbAlerts: adminProcedure.query(({ ctx }) => readAbsorbAlerts(ctx.supabase)),
  acknowledgePlatformAbsorb: adminProcedure.input(absorbAckInput)
    .mutation(({ ctx, input }) => acknowledgeAbsorb(ctx.supabase, input)),
  bill2ByModel: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }).strict().default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const to = new Date();
      const from = new Date(to.getTime() - input.days * DAY_MS);
      const { data, error } = await ctx.supabase.rpc('bill2_admin_call_report', {
        p_from: from.toISOString(), p_to: to.toISOString(), p_limit: BILL2_REPORT_LIMIT,
      });
      // The read function ships with a migration; until it is applied the report is unavailable, not empty.
      if (error || !Array.isArray(data)) {
        logger.warn('billing', 'bill2_model_report_unavailable', { code: error?.code ?? 'not_array' });
        return { available: false as const, from: from.toISOString(), to: to.toISOString() };
      }
      return {
        available: true as const, from: from.toISOString(), to: to.toISOString(),
        ...buildBill2ModelReport(data as Bill2CallReportRow[], BILL2_REPORT_LIMIT),
      };
    }),
});
