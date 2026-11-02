/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatToolDeps } from './chatToolDeps';

const actorId = '00000000-0000-4000-8000-000000000001', sessionId = '00000000-0000-4000-8000-000000000002';
const client = (result: unknown) => ({ rpc: vi.fn(async () => result) }) as unknown as SupabaseClient;

describe('chatToolDeps', () => {
  it('reads the caller\'s own benchmark accounts for this conversation, keeping only valid ones', async () => {
    const admin = client({ data: [{ platform: 'tiktok', account: '@someone' }, { platform: 7 }], error: null });
    const accounts = await chatToolDeps(admin, () => admin).benchmarkAccounts!(actorId, sessionId);
    expect(admin.rpc).toHaveBeenCalledWith('research_chat_benchmark_accounts', { a: actorId, s: sessionId, e: null });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ platform: 'tiktok' });
  });

  it('the workspace check runs before turn_open; without the post switches no tier is read', async () => {
    const admin = client({ data: ['v1'], error: null }), config = Promise.resolve({ data: [], error: null });
    expect(await chatToolDeps(admin, () => admin).workspace!(actorId, config)).toEqual({ sources: ['v1'], strategy: true, posts: null });
    expect(admin.rpc).toHaveBeenCalledWith('opc_workspace_sources', { p_actor_id: actorId });
    const failed = client({ data: null, error: { message: 'denied' } });
    await expect(chatToolDeps(failed, () => failed).workspace!(actorId, config)).rejects.toThrow('TURN_WORKSPACE_UNAVAILABLE');
  });

  it('a refused read throws, so prepareChatTools goes on without accounts', async () => {
    const admin = client({ data: null, error: { message: 'denied' } });
    await expect(chatToolDeps(admin, () => admin).benchmarkAccounts!(actorId, sessionId)).rejects.toThrow('TURN_BENCHMARK_ACCOUNTS_UNAVAILABLE');
  });
});
