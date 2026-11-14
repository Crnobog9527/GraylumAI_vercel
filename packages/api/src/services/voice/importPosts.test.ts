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
  it('a Post for Me connection is not supported even on a platform TikHub reads', async () => {
    const listed = [uuid(1), uuid(2), uuid(3)].map((connectionId, i) => ({ connectionId, platform: ['douyin', 'youtube', 'x'][i],
      displayHint: null, supported: true, fetchedAt: null, posts: 0 }));
    const rpc = vi.fn(async () => ({ data: listed, error: null }));
    const eqRole = vi.fn(async () => ({ data: [{ id: uuid(1), source: 'tikhub' },
      { id: uuid(2), source: 'postforme' }], error: null }));
    const eqActor = vi.fn(() => ({ eq: eqRole }));
    const from = vi.fn(() => ({ select: () => ({ eq: eqActor }) }));
    const sources = await voiceImportService({ rpc, from } as unknown as SupabaseClient, uuid(9)).sources();
    expect(eqActor).toHaveBeenCalledWith('actor_id', uuid(9));
    expect(eqRole).toHaveBeenCalledWith('role', 'own');
    expect(sources.map(s => s.supported)).toEqual([true, false, false]);
  });
  it('a failed connections read is "unavailable", not a list that looks importable', async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const from = () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }) }) });
    await expect(voiceImportService({ rpc, from } as unknown as SupabaseClient, uuid(9)).sources()).rejects.toThrow('VOICE_UNAVAILABLE');
  });
});
