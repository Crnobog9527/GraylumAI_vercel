/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import {
  clearPlatformSecret, platformSecretClearSchema, platformSecretSetSchema, platformSecretsView, setPlatformSecret,
} from '../services/platformSecrets/admin';

/** ADMIN-SECRETS: write-only. No procedure returns a stored value. */
export const platformSecretsRouter = router({
  status: adminProcedure.query(({ ctx }) => platformSecretsView(ctx.supabase)),
  set: adminProcedure.input(platformSecretSetSchema).mutation(async ({ ctx, input }) => {
    await setPlatformSecret(ctx.supabase, ctx.user.id, input);
    return platformSecretsView(ctx.supabase);
  }),
  clear: adminProcedure.input(platformSecretClearSchema).mutation(async ({ ctx, input }) => {
    await clearPlatformSecret(ctx.supabase, ctx.user.id, input);
    return platformSecretsView(ctx.supabase);
  }),
});
