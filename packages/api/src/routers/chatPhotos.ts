/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { sessionPhotos } from '../services/chatPhotos/photos';

/** The signed-in view route that serves one of the caller's own chat photos (apps/web/src/app/api/chat-photos/view). */
export const CHAT_PHOTO_VIEW_ROUTE = '/api/chat-photos/view';

/** Chat photos (Owner 2026-11-13): the caller's own photos of one conversation, by turn and position, as addresses of the
 * signed-in view route. Only the caller's own: the names are listed under the caller's profile, so another account's
 * conversation id lists nothing. */
export const chatPhotosRouter = router({
  list: protectedProcedure.input(z.object({ sessionId: z.string().uuid() }).strict()).query(async ({ ctx, input }) => {
    if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'CHAT_PHOTOS_UNAVAILABLE' });
    const photos = await sessionPhotos(ctx.supabaseAdmin, ctx.profileId, input.sessionId);
    return photos.map(photo => ({ turnId: photo.turnId, index: photo.index,
      src: `${CHAT_PHOTO_VIEW_ROUTE}?p=${encodeURIComponent(photo.path)}` }));
  }),
});
