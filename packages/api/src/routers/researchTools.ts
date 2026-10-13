/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import { researchToolsUpdateSchema, researchToolsView, setResearchToolsConfig } from '../services/research/toolsSettings';

export const researchToolsRouter = router({
  get: adminProcedure.query(({ ctx }) => researchToolsView(ctx.supabase)),
  set: adminProcedure.input(researchToolsUpdateSchema).mutation(async ({ ctx, input }) => {
    await setResearchToolsConfig(ctx.supabase, ctx.user.id, input);
    // Always answer with the server read-back, never the requested value.
    return researchToolsView(ctx.supabase);
  }),
});
