/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../trpc';
import { fusionSettings } from '../services/fusion/settings';
import { fusionSettingsView, saveFusionSettings } from '../services/fusion/settingsAdmin';

const unavailable = new Set(['FUSION_SETTINGS_UNAVAILABLE']);
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const code = cause instanceof Error && /^(FUSION|RUNTIME|BILL2)_[A-Z_]+$/.test(cause.message) ? cause.message
      : 'FUSION_SETTINGS_UNAVAILABLE';
    throw new TRPCError({ code: unavailable.has(code) ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST', message: code, cause });
  }
}
/** Dedicated Fusion settings (Master Plan §4.5); the generic settings route refuses this key. */
export const fusionSettingsRouter = router({
  get: adminProcedure.query(({ ctx }) => safe(() => fusionSettingsView(ctx.supabase))),
  update: adminProcedure.input(fusionSettings).mutation(({ ctx, input }) =>
    safe(() => saveFusionSettings(ctx.supabase, ctx.user.id, input))),
});
