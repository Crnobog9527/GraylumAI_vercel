/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { dataSchema } from '../../publishMonitor/data';
import { historiesSchema, reviewFrom, reviewPosts, supplementSchema, type History } from '../../publishMonitor/reviewData';
import { fitReview, NO_ENTITLEMENT, ownPostsResult } from '../agent/workspacePosts';
import type { TurnClients } from '../db';
import { READ_SOURCE_GUIDE, type SourceRead } from './source';

/*
 * CORE-PATH-V2 V2-6 part B: read_source over the user's confirmed workspace and own post data. Which sources are still allowed, and
 * the own-data tier, were settled before turn_open (chatToolDeps.ts); here each call is one free read through the read client, by the
 * owner's key, over exactly that. The model picks an id or a window; it can never widen them: a window above the tier is refused here
 * and the database only reads versions in the list. Library queries pass through to the library reader.
 */
export type PostsAccess = { windowDays: number; benchmarks: boolean; review: boolean };
export type WorkspaceAccess = { sources: string[]; strategy: boolean; posts: PostsAccess | null };
export const NO_ACCESS: WorkspaceAccess = { sources: [], strategy: false, posts: null };
const MAX_POST_READS = 2;
const UNAVAILABLE = { text: JSON.stringify({ kind: 'unavailable' }) };
const WORKSPACE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|strategy_report:[0-9a-f-]{36})$/;

export const sourceDescription = (library: boolean) => 'Read owned business context only when relevant. Omit query to list '
  + 'positioning/account/topic metadata; pass an exact returned id to read that source. Read-only; no internet access.'
  + (library ? READ_SOURCE_GUIDE : '');

const postsResult = z.object({ kind: z.literal('posts'), data: dataSchema,
  review: supplementSchema.omit({ histories: true }).extend({ histories: historiesSchema, benchmarkHistories: historiesSchema }).optional() });

async function readPosts(read: TurnClients['read'], actorId: string, sessionId: string, posts: PostsAccess, windowDays: number): Promise<SourceRead> {
  const { data, error } = await read.rpc('posts_turn_read', { p_actor_id: actorId, p_session_id: sessionId, p_window_days: windowDays,
    p_review: posts.review, p_benchmarks: posts.benchmarks });
  if (error) throw new Error('TURN_SOURCE_UNAVAILABLE');
  if ((data as { kind?: string } | null)?.kind !== 'posts') return { text: JSON.stringify(data) };
  const parsed = postsResult.parse(data), now = Date.now(), result = ownPostsResult(parsed.data, now);
  if (!parsed.review || result.kind !== 'my_posts') return { text: JSON.stringify(result) };
  const covered = { ...parsed.data, posts: reviewPosts(parsed.data, windowDays, now) };
  const histories = new Map<string, History>(parsed.review.histories.map(h => [h.postId, h.snapshots]));
  const review = reviewFrom(covered, histories, { ...parsed.review, histories: parsed.review.benchmarkHistories }, now);
  return { text: JSON.stringify(fitReview(parsed.data, result, review, now)) };
}

export function workspaceTurnReader(read: TurnClients['read'], actorId: string, sessionId: string, access: WorkspaceAccess,
  library?: (query: string) => Promise<SourceRead>) {
  const windows = !access.posts ? [] : [14, 30, 90].filter(days => days === 14 || days <= access.posts!.windowDays);
  let postReads = 0, strategyReads = 0;
  const workspace = async (query: string) => {
    const { data, error } = await read.rpc('workspace_turn_read', { p_actor_id: actorId, p_session_id: sessionId, p_query: query,
      p_allowed: access.sources });
    if (error) throw new Error('TURN_SOURCE_UNAVAILABLE');
    return data as { kind?: string; entries?: unknown[] };
  };
  return async (raw: string): Promise<SourceRead> => {
    const query = raw.trim();
    if (query === '') {
      const index = await workspace('');
      return { text: JSON.stringify(index.kind !== 'workspace_index' ? index : { ...index, entries: [...index.entries ?? [],
        ...windows.map(days => ({ id: `my_posts:${days}`, kind: 'my_posts', name: `我的作品 · ${days} 天`, windowDays: days,
          use: 'Saved own post metrics, free to read. Default 14 days. At most two reads per answer.' }))] }) };
    }
    const posts = /^my_posts(?::(14|30|90))?$/.exec(query);
    if (posts) {
      const days = Number(posts[1] ?? 14);
      if (!access.posts || !windows.includes(days)) return UNAVAILABLE;
      if (++postReads > MAX_POST_READS) return { text: JSON.stringify({ kind: 'unavailable', reason: 'read_limit', note: '本条回答的作品读取次数已用完' }) };
      if (access.posts.windowDays <= 0) return { text: JSON.stringify({ kind: 'my_posts', status: 'no_entitlement', note: NO_ENTITLEMENT, window_days: 14 }) };
      return readPosts(read, actorId, sessionId, access.posts, days);
    }
    if (WORKSPACE_ID.test(query)) {
      // Room was kept for one strategy result (up to 52000 bytes), whatever the read limit is.
      if (query.startsWith('strategy_report:') && (!access.strategy || ++strategyReads > 1)) return UNAVAILABLE;
      return { text: JSON.stringify(await workspace(query)) };
    }
    return library ? library(query) : UNAVAILABLE;
  };
}
