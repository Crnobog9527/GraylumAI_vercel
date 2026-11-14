/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { SOCIAL_PLATFORMS } from '../research/vendors/types';
import { listConnections } from '../publishMonitor/foundation';
import { voiceRpc } from './state';

/*
 * VOICE-2 PR-5 (Owner 2026-11-14: import the user's own past posts, billed by actual use): the posts come from the latest paid
 * TikHub read of an own connected account (数据复盘's daily update, kept seven days), so importing adds no supplier call and no charge.
 * The routes say which stored read is the posts list; the database takes each post's text from that read, never from the page.
 */
const uuid = z.string().uuid();
/** platform -> the TikHub route of its account's posts list (only platforms that have one can import). */
export function importRoutes(): Record<string, string> {
  return Object.fromEntries(SOCIAL_PLATFORMS.flatMap(platform => {
    const route = tikhubRouteId(platform, 'account_posts');
    return route ? [[platform, route]] : [];
  }));
}

export const importCandidatesInput = z.object({ connectionId: uuid }).strict();
export const importPostsInput = z.object({ connectionId: uuid, postIds: z.array(z.string().min(1).max(256)).min(1).max(30) }).strict();

/** autoTrack: the connection reads itself once a day (数据复盘 has no manual refresh for a TikHub account). */
export type ImportSource = { connectionId: string; platform: string; displayHint: string | null; supported: boolean;
  fetchedAt: string | null; posts: number; autoTrack: boolean };

/**
 * Only a TikHub connection is read into a stored posts list; a Post for Me one (YouTube, Instagram...) never is, so it is
 * "not supported" even where TikHub has a route for its platform. A connection the database lists but this read misses is
 * treated the same way (nothing to import). The connections are read through 数据复盘's own function: the table itself is closed
 * to the service role (a direct read is refused).
 */
/** A failed connections read is "unavailable" (the reason stays in the database log), never a list that looks importable. */
async function ownConnections(admin: SupabaseClient, actorId: string) {
  try { return await listConnections(admin, actorId); } catch { throw new Error('VOICE_UNAVAILABLE'); }
}

async function sourcesOf(admin: SupabaseClient, actorId: string, routes: Record<string, string>): Promise<ImportSource[]> {
  const [listed, rows] = await Promise.all([
    voiceRpc<Omit<ImportSource, 'autoTrack'>[]>(admin, 'voice_import_sources', { a: actorId, routes }),
    ownConnections(admin, actorId),
  ]);
  const byId = new Map(rows.filter(row => row.role === 'own').map(row => [row.id, row]));
  return listed.map(source => {
    const row = byId.get(source.connectionId);
    return { ...source, supported: source.supported && row?.source === 'tikhub', autoTrack: row?.consentAutoTrack === true };
  });
}
export type ImportCandidate = { postId: string; text: string; url: string | null; postedAt: string | null; imported: boolean };

export function voiceImportService(admin: SupabaseClient, actorId: string) {
  const routes = importRoutes();
  return {
    sources: () => sourcesOf(admin, actorId, routes),
    candidates: (input: z.infer<typeof importCandidatesInput>) => voiceRpc<{ fetchedAt: string | null; posts: ImportCandidate[] }>(admin,
      'voice_import_candidates', { a: actorId, cid: input.connectionId, routes }),
    importPosts: (input: z.infer<typeof importPostsInput>) => voiceRpc<{ imported: number; skipped: number }>(admin,
      'library_import_posts', { a: actorId, cid: input.connectionId, routes, ids: [...new Set(input.postIds)] }),
  };
}
