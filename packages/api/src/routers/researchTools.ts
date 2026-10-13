/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import { researchToolsUpdateSchema, researchToolsView, setResearchToolsConfig } from '../services/research/toolsSettings';

export const researchToolsRouter = router({
  get: adminProcedure.query(({ ctx }) => researchToolsView(ctx.supabase)),
  set: adminProcedure.input(researchToolsUpdateSchema).mutation(async ({ ctx, input }) => {
    // Answer with the writer's committed value (never the requested one); enrichment cannot fail it.
    const committed = await setResearchToolsConfig(ctx.supabase, ctx.user.id, input);
    return researchToolsView(ctx.supabase, committed);
  }),
});
