/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { readShotvivaRouteEnv } from '../lib/envValidator';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import {
  disconnectShotviva, readShotvivaStatus, ShotvivaConnectError,
} from '../services/connectors/shotviva/connect';
import { readImageJob } from '../services/connectors/shotviva/images';
import {
  deleteUserConnection, paidConnectorMember, readUserConnection, USER_CONNECTION_PROVIDERS, UserConnectionError,
} from '../services/connectors/userConnections';

/** INTEGRATION-SHOTVIVA: the signed-in user's own connector state. Connecting itself goes through the web routes
 * (/api/connectors/shotviva/connect and /callback), which need the browser cookie. */
type Ctx = { profileId: string; hasSupabaseAdminPrivileges: boolean; supabaseAdmin: Parameters<typeof readShotvivaStatus>[0]['admin'] };

function admin(ctx: Ctx, unavailable = 'SHOTVIVA_UNAVAILABLE') {
  if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: unavailable });
  return ctx.supabaseAdmin;
}
const failed = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  const code = error instanceof ShotvivaConnectError ? error.code : 'SHOTVIVA_UNAVAILABLE';
  throw new TRPCError({ code: code === 'SHOTVIVA_ACCOUNT_CLOSED' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE', message: code });
};

const providerInput = z.object({ provider: z.enum(USER_CONNECTION_PROVIDERS) }).strict();
const connectionFailed = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  const code = error instanceof UserConnectionError ? error.code : 'CONNECTION_UNAVAILABLE';
  throw new TRPCError({ code: code === 'CONNECTION_ACCOUNT_CLOSED' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE', message: code });
};

export const connectorsRouter = router({
  /** INTEGRATION-BASE: a connector with the user's own credential (Feishu Base). Never returns the credential. */
  connectionStatus: protectedProcedure.input(providerInput).query(async ({ ctx, input }) => {
    await checkRateLimitOrThrow(`connection-status:${ctx.profileId}`, 'api');
    try {
      const db = admin(ctx, 'CONNECTION_UNAVAILABLE');
      const [connection, eligible] = await Promise.all([readUserConnection(db, ctx.profileId, input.provider),
        paidConnectorMember(db, ctx.profileId)]);
      return { eligible, connected: connection !== null, label: connection?.label ?? null, last4: connection?.last4 ?? null,
        failed: connection?.failed ?? false };
    } catch (error) { return connectionFailed(error); }
  }),
  connectionDisconnect: protectedProcedure.input(providerInput).mutation(async ({ ctx, input }) => {
    try {
      await deleteUserConnection(admin(ctx, 'CONNECTION_UNAVAILABLE'), ctx.profileId, input.provider);
      return { connected: false as const };
    } catch (error) { return connectionFailed(error); }
  }),
  shotvivaStatus: protectedProcedure.query(async ({ ctx }) => {
    // Each read may ask Shotviva for the balance.
    await checkRateLimitOrThrow(`shotviva-status:${ctx.profileId}`, 'api');
    try {
      return await readShotvivaStatus({ admin: admin(ctx), baseUrl: readShotvivaRouteEnv().shotvivaBaseUrl, profileId: ctx.profileId });
    } catch (error) { return failed(error); }
  }),
  /** An image step's card: the job of the caller's own linked account (Shotviva checks the account), with a fresh address. */
  shotvivaImage: protectedProcedure.input(z.object({ jobId: z.string().uuid() }).strict()).query(async ({ ctx, input }) => {
    await checkRateLimitOrThrow(`shotviva-image:${ctx.profileId}`, 'api');
    try {
      const job = await readImageJob({ admin: admin(ctx), baseUrl: readShotvivaRouteEnv().shotvivaBaseUrl, profileId: ctx.profileId,
        jobId: input.jobId });
      // The signed address stays on the server: the page shows the image through /api/connectors/shotviva/image.
      return job.status === 'succeeded' ? { status: job.status, viewUrl: job.viewUrl } : job;
    } catch (error) { return failed(error); }
  }),
  shotvivaDisconnect: protectedProcedure.mutation(async ({ ctx }) => {
    try { return await disconnectShotviva({ admin: admin(ctx), profileId: ctx.profileId }); }
    catch (error) { return failed(error); }
  }),
});
