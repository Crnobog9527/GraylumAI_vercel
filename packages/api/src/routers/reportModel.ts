/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { readReportModel, reportModelOptions, saveReportModel } from '../services/report/modelSettings';
import { reportModelErrorCode } from '../services/report/modelErrors';
const moduleInput = z.object({ moduleId: z.string().uuid() }).strict();
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const message = reportModelErrorCode(cause instanceof Error ? cause.message : undefined)
      ?? 'REPORT_MODEL_CONFIG_UNAVAILABLE';
    throw new TRPCError({ code: message === 'REPORT_MODEL_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
}
export const reportModelRouter = router({
  get: adminProcedure.input(moduleInput).query(({ ctx, input }) =>
    safe(() => readReportModel(ctx.supabase, input.moduleId))),
  options: adminProcedure.query(({ ctx }) =>
    safe(() => reportModelOptions(ctx.supabase, ctx.user.id))),
  update: adminProcedure.input(moduleInput.extend({
    reportModelId: z.string().uuid().nullable(), expectedReportModelId: z.string().uuid().nullable(),
  })).mutation(({ ctx, input }) => safe(() => saveReportModel(ctx.supabase, ctx.user.id, input))),
});
