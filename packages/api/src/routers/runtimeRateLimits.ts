/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import {
  readRuntimeRateLimits, runtimeRateLimitsSchema, saveRuntimeRateLimits,
} from '../services/runtime/rateLimitSettings';

import { readStopLoss, saveStopLoss, stopLossConfigSchema, stopLossStatus, stopLossAlerts }
  from '../services/runtime/stopLossSettings';

import { providerBalanceInput, recordProviderBalance } from '../services/runtime/stopLossMonitor';

const enforcement = { admission: true, calls: true, pause: true } as const;
export const runtimeRateLimitsRouter = router({
  recordProviderBalance: adminProcedure.input(providerBalanceInput)
    .mutation(({ ctx, input }) => recordProviderBalance(ctx.supabase, input)),
  stopLossConfig: adminProcedure.query(({ ctx }) => readStopLoss(ctx.supabase)),
  updateStopLoss: adminProcedure.input(stopLossConfigSchema)
    .mutation(({ ctx, input }) => saveStopLoss(ctx.supabase, input)),
  stopLossStatus: adminProcedure.query(({ ctx }) => stopLossStatus(ctx.supabase)),
  stopLossAlerts: adminProcedure.query(({ ctx }) => stopLossAlerts(ctx.supabase)),
  get: adminProcedure.query(async ({ ctx }) => ({
    ...await readRuntimeRateLimits(ctx.supabase), enforcement,
  })),
  update: adminProcedure.input(runtimeRateLimitsSchema).mutation(async ({ ctx, input }) => ({
    ...await saveRuntimeRateLimits(ctx.supabase, input), enforcement,
  })),
});
