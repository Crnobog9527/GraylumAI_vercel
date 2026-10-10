import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { diagnosticsRouter } from '../../routers/diagnostics';
import {
  DiagnosticsService,
  hasRoutingEvidence,
  matchBillingSettleByRequestId,
  matchBillingSettleForUsage,
} from '../diagnostics';

describe('diagnostics helpers', () => {
  it('matches settle rows by metadata requestId', () => {
    const matched = matchBillingSettleByRequestId([
      {
        id: 'settle-1',
        metadata: {
          requestId: 'req-123',
          actualCredits: 1,
        },
      },
      {
        id: 'settle-2',
        metadata: {
          requestId: 'req-456',
          actualCredits: 2,
        },
      },
    ], 'req-456');

    expect(matched?.id).toBe('settle-2');
  });

  it('accepts routingReason as valid routing evidence', () => {
    expect(hasRoutingEvidence({}, { routingReason: '智能路由: 复杂任务使用 Sonnet' })).toBe(true);
    expect(hasRoutingEvidence({}, {})).toBe(false);
  });

  it('falls back to conversation and closest timestamp when legacy settle rows miss requestId', () => {
    const matched = matchBillingSettleForUsage([
      {
        id: 'settle-older',
        created_at: '2026-03-09T06:10:00.000Z',
        metadata: {
          response: {
            conversationId: 'conv-123',
          },
        },
      },
      {
        id: 'settle-closest',
        created_at: '2026-03-09T06:10:54.491Z',
        metadata: {
          response: {
            conversationId: 'conv-123',
          },
        },
      },
    ], {
      conversation_id: 'conv-123',
      request_id: 'req-missing-from-legacy-settle',
      created_at: '2026-03-09T06:10:54.622Z',
    });

    expect(matched?.id).toBe('settle-closest');
  });
});

// Chainable, awaitable PostgREST stand-in that records the table and returns fixed rows.
function createResultsBuilder(rows: unknown[] = [], count = 0) {
  const result = { data: rows, error: null, count };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'range', 'delete']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

describe('diagnostics privileged client separation', () => {
  it('routes privileged RPCs and every diagnostic_results access through the service-role client', async () => {
    const userRpc = vi.fn(() => {
      throw new Error('privileged RPC dispatched through the user client');
    });
    const userFrom = vi.fn((table: string) => {
      // 0146: clients have no privileges on diagnostic_results.
      if (table === 'diagnostic_results') throw new Error('diagnostic_results dispatched through the user client');
      return {
        select: vi.fn(() => ({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
    });
    const adminRpc = vi.fn(async (name: string) => {
      if (name === 'atomic_pre_deduct') {
        return { data: [{ pre_deduct_id: 'pre-deduct-1' }], error: null };
      }

      return { data: [], error: null };
    });
    const adminInsert = vi.fn().mockResolvedValue({ error: null });
    const adminFrom = vi.fn(() => Object.assign(createResultsBuilder(), { insert: adminInsert }));

    const service = new DiagnosticsService({
      supabase: { rpc: userRpc, from: userFrom } as any,
      supabaseAdmin: { rpc: adminRpc, from: adminFrom } as any,
      userId: 'user-1',
    });

    await service.getTestHistory('billing_prededuct');
    await service.getSummaryStats();
    await service.getLatestResults();
    const billingResult = await service.runSingleTest('billing_prededuct');

    expect(billingResult?.status).toBe('warning');
    // The 0005 view/RPCs are absent on staging: history, summary, latest results and the result
    // write all use diagnostic_results through the service role (clients have no access since 0146).
    expect(adminRpc.mock.calls.map(([name]) => name)).not.toEqual(expect.arrayContaining([
      'get_test_history', 'get_diagnostic_summary',
    ]));
    expect(userRpc).not.toHaveBeenCalled();
    expect(userFrom).not.toHaveBeenCalledWith('diagnostic_results');
    expect(userFrom).not.toHaveBeenCalledWith('diagnostic_latest_results');
    expect(new Set(adminFrom.mock.calls.map(([table]) => table))).toEqual(new Set(['diagnostic_results']));
    expect(adminInsert).toHaveBeenCalledTimes(1);
  });
});

function createProfileQueryBuilder() {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };

  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.single.mockResolvedValue({
    data: {
      id: 'admin-user',
      role: 'admin',
      status: 'active',
      nickname: 'Admin',
      email: 'admin@example.com',
    },
    error: null,
  });

  return builder;
}

function createRoutedDiagnosticsCaller() {
  const diagnosticInsert = vi.fn().mockResolvedValue({ error: null });
  const userFrom = vi.fn((table: string) => {
    if (table === 'profiles') {
      return createProfileQueryBuilder();
    }

    if (table === 'billing_history') {
      return { select: () => ({ limit: async () => ({ data: [], error: null }) }) };
    }

    throw new Error(`Unexpected user-scoped table ${table}`);
  });
  const userRpc = vi.fn(() => {
    throw new Error('privileged RPC dispatched through the user client');
  });
  const userSupabase = { from: userFrom, rpc: userRpc };

  const adminFrom = vi.fn((table: string) => {
    if (table === 'diagnostic_results') {
      return Object.assign(createResultsBuilder(), { insert: diagnosticInsert });
    }
    throw new Error(`ordinary read dispatched through admin client: ${table}`);
  });
  const adminRpc = vi.fn(async (name: string) => {
    if (name === 'atomic_pre_deduct') {
      return { data: [{ pre_deduct_id: 'pre-deduct-1' }], error: null };
    }

    if (name === 'atomic_refund') {
      return { data: [], error: null };
    }

    throw new Error(`Unexpected admin RPC ${name}`);
  });
  const adminSupabase = { from: adminFrom, rpc: adminRpc };

  const caller = diagnosticsRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userSupabase,
    supabaseAuth: userSupabase,
    supabasePublic: {},
    supabaseAdmin: adminSupabase,
    hasSupabaseAdminPrivileges: true,
  } as any);

  return {
    caller,
    userSupabase,
    adminSupabase,
    userFrom,
    userRpc,
    adminFrom,
    adminRpc,
    diagnosticInsert,
  };
}

describe('diagnostics routed client contract', () => {
  it('keeps user-scoped reads user-scoped and diagnostic_results on the service-role client', async () => {
    const {
      caller,
      userSupabase,
      adminSupabase,
      userFrom,
      userRpc,
      adminFrom,
      adminRpc,
      diagnosticInsert,
    } = createRoutedDiagnosticsCaller();

    expect(userSupabase).not.toBe(adminSupabase);

    await expect(caller.getLatestResults()).resolves.toEqual([]);
    await expect(caller.runSingleTest({ testId: 'billing_prededuct' })).resolves.toMatchObject({
      status: 'warning',
    });

    expect(userFrom).toHaveBeenCalledWith('profiles');
    expect(userFrom).not.toHaveBeenCalledWith('diagnostic_latest_results');
    expect(userFrom).not.toHaveBeenCalledWith('diagnostic_results');
    expect(userRpc).not.toHaveBeenCalled();
    expect(new Set(adminFrom.mock.calls.map(([table]) => table))).toEqual(new Set(['diagnostic_results']));
    expect(adminRpc.mock.calls.map(([name]) => name)).toEqual([
    ]);
    expect(diagnosticInsert).toHaveBeenCalledTimes(1);
  });

  it('locks the C7 routing and service-role constructor wiring', () => {
    const trpcSource = readFileSync(new URL('../../trpc.ts', import.meta.url), 'utf8');
    const routerSource = readFileSync(new URL('../../routers/diagnostics.ts', import.meta.url), 'utf8');
    const cronSource = readFileSync(
      new URL('../../../../../apps/web/src/app/api/cron/diagnostics/route.ts', import.meta.url),
      'utf8',
    );

    expect(trpcSource).toContain('supabase: userScopedSupabase,\n      userScopedSupabase,');
    expect(trpcSource).toContain(
      'supabase: ctx.supabaseAdmin,\n      userScopedSupabase: ctx.userScopedSupabase,',
    );
    expect(routerSource.match(/supabase: ctx\.userScopedSupabase,/g) ?? []).toHaveLength(9);
    expect(routerSource.match(/supabaseAdmin: ctx\.supabaseAdmin,/g) ?? []).toHaveLength(9);
    expect(routerSource).not.toContain('supabase: ctx.supabase,');
    expect(routerSource).toContain('getDiagnosticsHealthCheck(ctx.userScopedSupabase, ctx.supabaseAdmin)');
    expect(routerSource).toContain('getRecentRunsData(ctx.supabaseAdmin');
    expect(routerSource).not.toContain('getRecentRunsData(ctx.userScopedSupabase');
    expect(routerSource).toContain("await ctx.supabaseAdmin\n        .from('diagnostic_results')");
    expect(routerSource).not.toContain("await ctx.userScopedSupabase\n        .from('diagnostic_results')");
    expect(cronSource).toContain(
      'new DiagnosticsService({\n      supabase,\n      supabaseAdmin: supabase,',
    );
  });
});

describe('billing diagnostic service uses only real read paths', () => {
  it.each(['healthy', 'query failure', 'mismatch'] as const)('keeps three read-only probes and reports the unavailable stop-loss monitor: %s', async mode => {
    const writes: string[] = [];
    const rpc = vi.fn(async (name: string) => {
      if (name !== 'research_billing_summary') throw new Error('Mutating RPC is forbidden');
      return { data: { count: 0, credits: 0 }, error: null };
    });
    const from = vi.fn((table: string) => {
      if (table === 'diagnostic_results') return { insert: async () => { writes.push(table); return { error: null }; } };
      const response = { data: mode === 'mismatch' && table === 'ai_usage_logs' ? [{ status: 'success' }] : [],
        error: mode === 'query failure' && table === 'billing_history' ? { message: 'synthetic read failure' } : null };
      const builder = {
        select() { return this; }, eq() { return this; }, gte() { return this; }, lt() { return this; },
        limit() { return Promise.resolve(response); },
        maybeSingle() { return Promise.resolve({ data: { value: '2026-01-01T00:00:00Z' }, error: null }); },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(response).then(resolve); },
      };
      return builder;
    });
    const adminRpc = vi.fn(() => { throw new Error('No privileged billing mutations allowed'); });
    const service = new DiagnosticsService({ supabase: { from, rpc } as never,
      supabaseAdmin: { from, rpc: adminRpc } as never, userId: 'synthetic-admin' });
    const result = await service.runCategoryTests('billing');
    expect(result.results.filter(r => r.testId !== 'runtime_stop_loss').map(r => r.status)).toEqual(mode === 'query failure'
      ? ['failed', 'failed', 'failed'] : ['warning', 'warning', mode === 'mismatch' ? 'failed' : 'passed']);
    expect(result.results.find(r => r.testId === 'runtime_stop_loss')?.status).toBe('error');
    expect(adminRpc).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['research_billing_summary']);
    expect(writes).toEqual(['diagnostic_results']);
    expect(result.saveStatus?.saved).toBe(true);
  });
});
