/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import {
  readRuntimeRateLimits, runtimeRateLimitsSchema, saveRuntimeRateLimits,
} from '../services/runtime/rateLimitSettings';

// Configuration can be prepared independently. Do not advertise enforcement before host wiring.
const enforcement = { admission: false, calls: false, pause: false } as const;
export const runtimeRateLimitsRouter = router({
  get: adminProcedure.query(async ({ ctx }) => ({
    ...await readRuntimeRateLimits(ctx.supabase), enforcement,
  })),
  update: adminProcedure.input(runtimeRateLimitsSchema).mutation(async ({ ctx, input }) => ({
    ...await saveRuntimeRateLimits(ctx.supabase, input), enforcement,
  })),
});
