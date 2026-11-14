/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { importPostsInput, importRoutes, voiceImportService } from './importPosts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('importing the user\'s own posts (VOICE-2 PR-5)', () => {
  it('knows the posts-list route of every platform that has one', () => {
    const routes = importRoutes();
    expect(Object.keys(routes).sort()).toEqual(['bilibili', 'douyin', 'instagram', 'tiktok', 'weibo', 'x', 'xiaohongshu', 'youtube']);
    expect(Object.values(routes).every(route => route.startsWith('/'))).toBe(true);
  });
  it('takes one to thirty post ids and never the posts\' text', () => {
    expect(importPostsInput.safeParse({ connectionId: uuid(1), postIds: ['a'] }).success).toBe(true);
    expect(importPostsInput.safeParse({ connectionId: uuid(1), postIds: [] }).success).toBe(false);
    expect(importPostsInput.safeParse({ connectionId: uuid(1), postIds: Array.from({ length: 31 }, (_, i) => 'p' + i) }).success).toBe(false);
    expect(importPostsInput.safeParse({ connectionId: uuid(1), postIds: ['a'], text: 'x' }).success).toBe(false);
  });
  it('calls the database for the signed-in account with the routes; duplicates sent once', async () => {
    const rpc = vi.fn(async () => ({ data: { imported: 1, skipped: 0 }, error: null }));
    const service = voiceImportService({ rpc } as unknown as SupabaseClient, uuid(9));
    await service.importPosts({ connectionId: uuid(1), postIds: ['a', 'a', 'b'] });
    expect(rpc).toHaveBeenCalledWith('library_import_posts', { a: uuid(9), cid: uuid(1), routes: importRoutes(), ids: ['a', 'b'] });
    await service.candidates({ connectionId: uuid(1) });
    expect(rpc).toHaveBeenLastCalledWith('voice_import_candidates', { a: uuid(9), cid: uuid(1), routes: importRoutes() });
  });
  // Only RPCs: social_connections is closed to the service role on the real database, so a client without `from` must do.
  const connection = (n: number, source: string, consentAutoTrack: boolean) => ({ id: uuid(n), businessId: uuid(20), accountProjectId: uuid(21),
    role: 'own', source, platform: 'douyin', displayHint: null, status: 'connected', consentRead: true, consentAutoTrack,
    consentPublish: false, lastSuccessAt: null, postCount: 0 });
  const listed = [uuid(1), uuid(2), uuid(3)].map((connectionId, i) => ({ connectionId, platform: ['douyin', 'youtube', 'x'][i],
    displayHint: null, supported: true, fetchedAt: null, posts: 0 }));
  it('a Post for Me connection is not supported even on a platform TikHub reads; a TikHub one keeps its daily-update switch', async () => {
    const rpc = vi.fn(async (name: string) => name === 'voice_import_sources' ? { data: listed, error: null }
      : { data: [connection(1, 'tikhub', false), connection(2, 'postforme', true)], error: null });
    const sources = await voiceImportService({ rpc } as unknown as SupabaseClient, uuid(9)).sources();
    expect(rpc).toHaveBeenCalledWith('publish_monitor_connections', { a: uuid(9) });
    expect(sources.map(s => [s.supported, s.autoTrack])).toEqual([[true, false], [false, true], [false, false]]);
  });
  it('a failed connections read is "unavailable", not a list that looks importable', async () => {
    const rpc = vi.fn(async (name: string) => name === 'voice_import_sources' ? { data: listed, error: null }
      : { data: null, error: { message: 'permission denied' } });
    await expect(voiceImportService({ rpc } as unknown as SupabaseClient, uuid(9)).sources()).rejects.toThrow('VOICE_UNAVAILABLE');
  });
});
