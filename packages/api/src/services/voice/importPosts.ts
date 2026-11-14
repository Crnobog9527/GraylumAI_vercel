/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { SOCIAL_PLATFORMS } from '../research/vendors/types';
import { voiceRpc } from './state';

/*
 * VOICE-2 PR-5 (Owner 2026-11-14: import the user's own past posts, billed by actual use): the posts come from the latest paid
 * TikHub read of an own connected account (数据复盘's refresh, kept seven days), so importing adds no supplier call and no charge.
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

export type ImportSource = { connectionId: string; platform: string; displayHint: string | null; supported: boolean;
  fetchedAt: string | null; posts: number };
export type ImportCandidate = { postId: string; text: string; url: string | null; postedAt: string | null; imported: boolean };

export function voiceImportService(admin: SupabaseClient, actorId: string) {
  const routes = importRoutes();
  return {
    sources: () => voiceRpc<ImportSource[]>(admin, 'voice_import_sources', { a: actorId, routes }),
    candidates: (input: z.infer<typeof importCandidatesInput>) => voiceRpc<{ fetchedAt: string | null; posts: ImportCandidate[] }>(admin,
      'voice_import_candidates', { a: actorId, cid: input.connectionId, routes }),
    importPosts: (input: z.infer<typeof importPostsInput>) => voiceRpc<{ imported: number; skipped: number }>(admin,
      'library_import_posts', { a: actorId, cid: input.connectionId, routes, ids: [...new Set(input.postIds)] }),
  };
}
