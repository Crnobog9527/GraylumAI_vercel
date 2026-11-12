/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { readShotvivaRouteEnv } from '../lib/envValidator';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import {
  disconnectShotviva, readShotvivaStatus, ShotvivaConnectError,
} from '../services/connectors/shotviva/connect';

/** INTEGRATION-SHOTVIVA: the signed-in user's own connector state. Connecting itself goes through the web routes
 * (/api/connectors/shotviva/connect and /callback), which need the browser cookie. */
type Ctx = { profileId: string; hasSupabaseAdminPrivileges: boolean; supabaseAdmin: Parameters<typeof readShotvivaStatus>[0]['admin'] };

function admin(ctx: Ctx) {
  if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'SHOTVIVA_UNAVAILABLE' });
  return ctx.supabaseAdmin;
}
const failed = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  const code = error instanceof ShotvivaConnectError ? error.code : 'SHOTVIVA_UNAVAILABLE';
  throw new TRPCError({ code: code === 'SHOTVIVA_ACCOUNT_CLOSED' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE', message: code });
};

export const connectorsRouter = router({
  shotvivaStatus: protectedProcedure.query(async ({ ctx }) => {
    // Each read may ask Shotviva for the balance.
    await checkRateLimitOrThrow(`shotviva-status:${ctx.profileId}`, 'api');
    try {
      return await readShotvivaStatus({ admin: admin(ctx), baseUrl: readShotvivaRouteEnv().shotvivaBaseUrl, profileId: ctx.profileId });
    } catch (error) { return failed(error); }
  }),
  shotvivaDisconnect: protectedProcedure.mutation(async ({ ctx }) => {
    try { return await disconnectShotviva({ admin: admin(ctx), profileId: ctx.profileId }); }
    catch (error) { return failed(error); }
  }),
});
