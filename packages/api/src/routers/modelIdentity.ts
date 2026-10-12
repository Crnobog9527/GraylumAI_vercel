/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import {
  modelIdentityGuardUpdateSchema, modelIdentityGuardView, setModelIdentityGuard,
} from '../services/modelIdentity/guardSetting';

export const modelIdentityRouter = router({
  get: adminProcedure.query(({ ctx }) => modelIdentityGuardView(ctx.supabase)),
  set: adminProcedure.input(modelIdentityGuardUpdateSchema).mutation(async ({ ctx, input }) => {
    await setModelIdentityGuard(ctx.supabase, ctx.user.id, input);
    // Always answer with the server read-back, never the requested value.
    return modelIdentityGuardView(ctx.supabase);
  }),
});
