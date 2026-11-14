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
});
