/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-2b router: admin allow/deny, server-stamped hard-cap attestations, revision conflicts and
// audit summaries. The fake rpc mirrors migration 0254; packages/db/tests/research-tools covers SQL.
import { describe, expect, it } from 'vitest';
import { researchToolsRouter } from './researchTools';
import { setResearchToolsConfig } from '../services/research/toolsSettings';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
type Role = 'admin' | 'user' | 'anonymous';

function harness(role: Role) {
  let stored: Record<string, unknown> | null = null;
  const rpcCalls: Array<Record<string, unknown>> = [];
  const logs: Array<{ admin_id: string; details: Record<string, unknown>; created_at: string }> = [];
  const chain = (rows: () => unknown[], single?: unknown) => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'in']) q[k] = () => q;
    q.limit = async () => ({ data: rows(), error: null });
    q.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
    q.single = async () => ({ data: single, error: null });
    q.maybeSingle = async () => ({ data: stored ? { value: stored } : null, error: null });
    return q;
  };
  const db = {
    from: (table: string) => {
      if (table === 'system_settings') return chain(() => []);
      if (table === 'user_activity_logs') return chain(() => [...logs].reverse());
      if (table === 'profiles') return chain(() => [{ id: ACTOR, email: 'admin@example.test' }],
        { id: ACTOR, role, status: 'active', is_deleted: 'false', credits: 0, nickname: 'Synthetic', email: 'admin@example.test' });
      throw new Error(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'research_tools_config_set') throw new Error(name);
      rpcCalls.push(args);
      if (role !== 'admin') return { data: null, error: { code: '42501', message: 'RESEARCH_TOOLS_ACTOR_DENIED' } };
      const revision = Number(stored?.revision ?? 0);
      if (args.p_expected_revision !== revision) return { data: null, error: { code: 'PT409', message: 'conflict' } };
      const config = args.p_config as { vendors: Record<string, { enabled: boolean }> };
      const priorVendors = (stored?.vendors ?? {}) as Record<string, { hardCapAttested: unknown }>;
      const vendors: Record<string, unknown> = {};
      for (const v of ['tikhub', 'parallel', 'firecrawl']) {
        const attested = (args.p_attest_vendors as string[]).includes(v)
          ? { by: args.p_actor, at: '2026-10-14T00:00:00.000000Z' } : priorVendors[v]?.hardCapAttested ?? null;
        if (config.vendors[v].enabled && !attested) return { data: null, error: { code: '23514', message: 'RESEARCH_TOOLS_HARD_CAP_REQUIRED' } };
        vendors[v] = { enabled: config.vendors[v].enabled, hardCapAttested: attested };
      }
      stored = { ...config, vendors, revision: revision + 1, updatedBy: args.p_actor, updatedAt: '2026-10-14T00:00:00.000000Z' };
      logs.push({ admin_id: String(args.p_actor), created_at: '2026-10-14T00:00:00Z', details: {
        revision: revision + 1, enabled: (config as { enabled?: boolean }).enabled, hardCapAttested: args.p_attest_vendors } });
      return { data: stored, error: null };
    },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: ACTOR, email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: researchToolsRouter.createCaller(ctx), db, rpcCalls, logs, stored: () => stored };
}

const input = (enabled: Partial<Record<'tikhub' | 'parallel' | 'firecrawl', boolean>>, attestHardCap: string[] = [], expectedRevision = 0) => ({
  config: {
    version: 1, enabled: true,
    vendors: { tikhub: { enabled: !!enabled.tikhub }, parallel: { enabled: !!enabled.parallel }, firecrawl: { enabled: !!enabled.firecrawl } },
    verifiedPlatforms: ['tiktok'], benchmarkPlatforms: ['tiktok'],
    routes: [
      { platform: 'tiktok', kind: 'account_posts', vendor: 'tikhub', route: '/tiktok/app/v3/fetch_user_post_videos', backup: null, maxUnitsPerCall: '1' },
      { platform: 'tiktok', kind: 'account_profile', vendor: 'tikhub', route: '/tiktok/app/v3/handler_user_profile', backup: null, maxUnitsPerCall: '1' },
    ],
    limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
    recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
  },
  attestHardCap, expectedRevision,
});

describe('researchTools router', () => {
  it.each(['user', 'anonymous'] as const)('denies %s reads and writes before any database write', async role => {
    const h = harness(role);
    await expect(h.caller.get()).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED/) });
    await expect(h.caller.set(input({}) as never)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED/) });
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('lets an admin save and answers with the server read-back', async () => {
    const h = harness('admin');
    const view = await h.caller.set(input({}) as never);
    expect(view).toMatchObject({ source: 'configured', revision: 1, updatedBy: ACTOR, updatedByEmail: 'admin@example.test' });
    expect(h.rpcCalls[0]).toMatchObject({ p_actor: ACTOR, p_expected_revision: 0, p_attest_vendors: [] });
  });

  it('refuses to enable a supplier whose platform hard cap was never attested, and allows it once attested', async () => {
    const h = harness('admin');
    await expect(h.caller.set(input({ tikhub: true }) as never)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'RESEARCH_TOOLS_HARD_CAP_REQUIRED' });
    expect(h.rpcCalls).toHaveLength(0);
    const view = await h.caller.set(input({ tikhub: true }, ['tikhub']) as never);
    expect(view.config.vendors.tikhub).toEqual({ enabled: true, hardCapAttested: { by: ACTOR, at: '2026-10-14T00:00:00.000000Z' } });
    // The attestation persists: disabling and re-enabling later needs no new attestation.
    await h.caller.set(input({}, [], 1) as never);
    expect((await h.caller.set(input({ tikhub: true }, [], 2) as never)).config.vendors.tikhub.enabled).toBe(true);
  });

  it('never accepts client-written attestations, revision or author fields', async () => {
    const h = harness('admin');
    const forged = input({ tikhub: true });
    (forged.config.vendors.tikhub as Record<string, unknown>).hardCapAttested = { by: ACTOR, at: '2026-01-01T00:00:00Z' };
    await expect(h.caller.set(forged as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(h.caller.set({ ...input({}), config: { ...input({}).config, revision: 9 } } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('rejects invalid shapes and maps stale revisions to CONFLICT', async () => {
    const h = harness('admin');
    const bad = input({});
    (bad.config.routes as Array<Record<string, unknown>>)[0].route = '/douyin/search/fetch_video_search_v5';
    await expect(h.caller.set(bad as never)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'RESEARCH_TOOLS_INPUT_INVALID' });
    await h.caller.set(input({}) as never);
    await expect(h.caller.set(input({}, [], 0) as never)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a database-side denial to FORBIDDEN even if the API admin check were bypassed', async () => {
    const h = harness('user');
    await expect(setResearchToolsConfig(h.db as never, ACTOR, input({}))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.rpcCalls).toHaveLength(1);
  });

  it('keeps audit history to summaries, never full values or secrets', async () => {
    const h = harness('admin');
    const view = await h.caller.set(input({ tikhub: true }, ['tikhub']) as never);
    expect(view.history[0]).toMatchObject({ revision: 1, enabled: true, hardCapAttested: ['tikhub'], operatorEmail: 'admin@example.test' });
    expect(JSON.stringify(view.history)).not.toMatch(/routes|apiKey|api_key|secret|token/i);
  });

});
