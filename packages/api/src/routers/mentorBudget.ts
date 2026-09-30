/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { router, adminProcedure } from '../trpc';
import { createSafeInternalError } from '../lib/publicError';
import { purposeBudgetsSchema, readPurposeBudgetView, savePurposeBudgets } from '../services/runtime/purposeBudgets';
export const mentorBudgetRouter = router({
  get: adminProcedure.query(async ({ ctx }) => {
    try { return await readPurposeBudgetView(ctx.supabase); }
    catch (cause) { throw createSafeInternalError(cause, '无法读取用途预算，请稍后重试'); }
  }),
  update: adminProcedure.input(purposeBudgetsSchema).mutation(async ({ ctx, input }) => {
    try {
      return await savePurposeBudgets(ctx.supabase, input);
    } catch (cause) { throw createSafeInternalError(cause, '无法保存用途预算，请稍后重试'); }
  }),
});
