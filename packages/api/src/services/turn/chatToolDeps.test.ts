/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatToolDeps } from './chatToolDeps';
import { clearSkillCatalogCache } from './skills/skillCatalog';
import { clearSkillResourceCache, packageHash, sha256 } from '../skills/loader';

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

  it('a request with two Skills asks who the caller is once and reads the visible modules once, and loads both', async () => {
    clearSkillCatalogCache(); clearSkillResourceCache();
    const ids = [1, 2].map(n => ({ module: `00000000-0000-4000-8000-0000000000a${n}`, skill: `00000000-0000-4000-8000-0000000000b${n}`,
      revision: `00000000-0000-4000-8000-0000000000c${n}`, name: `demo-${n}` }));
    const manifests = new Map(ids.map(id => {
      const text = `---\nname: ${id.name}\ndescription: Demo.\n---\nBody ${id.name}\n`;
      const p = { packageId: id.skill, revisionId: id.revision, directoryName: id.name, packageHash: '', tasks: {}, requiredCapabilities: [],
        files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(text), sha256: sha256(text), mediaType: 'text/markdown' as const, requires: [] }] };
      p.packageHash = packageHash(p);
      return [id.module, { manifest: p, text }] as const;
    }));
    const getUser = vi.fn(async () => ({ data: { user: { id: actorId, email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }));
    const visibleReads = vi.fn(async () => ({ data: ids.map(id => ({ id: id.module, active: true })), error: null }));
    const userChain: Record<string, unknown> = { select: () => userChain, eq: () => userChain, order: () => userChain, limit: visibleReads,
      single: async () => { throw new Error('a per-module visibility read must not happen'); } };
    const user = { auth: { getUser }, from: vi.fn(() => userChain) } as unknown as SupabaseClient;
    const rows = (data: unknown) => { const chain: Record<string, unknown> = { select: () => chain, in: () => chain, eq: () => chain,
      order: async () => ({ data, error: null }), then: (resolve: (value: unknown) => void) => resolve({ data, error: null }) }; return chain; };
    const rpc = vi.fn(async (_name: string, args: { p_module_id: string; p_path: string | null; p_paths?: string[] }) => {
      const found = manifests.get(args.p_module_id)!;
      if (args.p_paths) return { data: { files: Object.fromEntries(args.p_paths.map(path => [path, Buffer.from(found.text).toString('base64')])) }, error: null };
      return { data: args.p_path === null ? found.manifest : args.p_path === '' ? true : Buffer.from(found.text).toString('base64'), error: null };
    });
    const admin = { rpc, from: vi.fn((table: string) => rows(table === 'modules'
      ? ids.map(id => ({ id: id.module, skill_id: id.skill, social_media_related: false, uses_user_voice: false }))
      : ids.map(id => ({ id: id.skill, status: 'published', published_version: 1 })))) } as unknown as SupabaseClient;
    const { catalog, prepared } = await chatToolDeps(admin, () => user).skills!(actorId, undefined);
    expect(catalog.map(item => item.name)).toEqual(['demo-1', 'demo-2']);
    expect([...prepared.keys()]).toEqual(['demo-1', 'demo-2']);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(visibleReads).toHaveBeenCalledTimes(1);
    expect(user.from).toHaveBeenCalledTimes(1);
  });
});
