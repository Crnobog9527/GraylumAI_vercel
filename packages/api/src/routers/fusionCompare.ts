/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { protectedProcedure, router } from '../trpc';
import { StagingAccessError, stagingProcedureError } from '../services/runtime/stagingErrors';
import { compareOptions } from '../services/fusion/compareOptions';

/** FUSION-COMPARE API. This first slice is read only; estimate, start, streaming, adoption and stop follow in the next PRs.
 * Everything is checked on the server again at start: the picker only shows what is allowed. */
const reader = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const result = await next({ ctx: { ...ctx, admin: ctx.supabaseAdmin } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw stagingProcedureError(cause, path); }
});

export const fusionCompareRouter = router({
  /** The picker's contents. A failed settings read reads as "off" to the page rather than leaking a database error. */
  options: reader.query(({ ctx }) => compareOptions(ctx.admin, ctx.user.id)),
});
