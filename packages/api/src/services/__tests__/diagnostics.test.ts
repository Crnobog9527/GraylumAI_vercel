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

describe('diagnostics privileged client separation', () => {
  it('routes privileged RPCs through the service-role client and keeps reads user-scoped', async () => {
    const userRpc = vi.fn(() => {
      throw new Error('privileged RPC dispatched through the user client');
    });
    const userFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
      insert: vi.fn().mockResolvedValue({ error: null }),
    }));
    const adminRpc = vi.fn(async (name: string) => {
      if (name === 'atomic_pre_deduct') {
        return { data: [{ pre_deduct_id: 'pre-deduct-1' }], error: null };
      }

      return { data: [], error: null };
    });
    const adminFrom = vi.fn();

    const service = new DiagnosticsService({
      supabase: { rpc: userRpc, from: userFrom } as any,
      supabaseAdmin: { rpc: adminRpc, from: adminFrom } as any,
      userId: 'user-1',
    });

    await service.getTestHistory('billing_prededuct');
    await service.getSummaryStats();
    await service.getLatestResults();
    const billingResult = await service.runSingleTest('billing_prededuct');

    expect(billingResult?.status).toBe('passed');
    expect(adminRpc.mock.calls.map(([name]) => name)).toEqual([
      'get_test_history',
      'get_diagnostic_summary',
      'atomic_pre_deduct',
      'atomic_refund',
    ]);
    expect(userRpc).not.toHaveBeenCalled();
    expect(userFrom).toHaveBeenCalledWith('diagnostic_latest_results');
    expect(adminFrom).not.toHaveBeenCalled();
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

function createLatestResultsQueryBuilder() {
  const builder = {
    select: vi.fn(),
    order: vi.fn(),
  };

  builder.select.mockReturnValue(builder);
  builder.order.mockResolvedValue({ data: [], error: null });

  return builder;
}

function createRoutedDiagnosticsCaller() {
  const diagnosticInsert = vi.fn().mockResolvedValue({ error: null });
  const userFrom = vi.fn((table: string) => {
    if (table === 'profiles') {
      return createProfileQueryBuilder();
    }

    if (table === 'diagnostic_latest_results') {
      return createLatestResultsQueryBuilder();
    }

    if (table === 'diagnostic_results') {
      return { insert: diagnosticInsert };
    }

    throw new Error(`Unexpected user-scoped table ${table}`);
  });
  const userRpc = vi.fn(() => {
    throw new Error('privileged RPC dispatched through the user client');
  });
  const userSupabase = { from: userFrom, rpc: userRpc };

  const adminFrom = vi.fn((table: string) => {
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
  it('preserves the user-scoped client through adminProcedure and keeps privileged RPCs admin-only', async () => {
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
      status: 'passed',
    });

    expect(userFrom).toHaveBeenCalledWith('profiles');
    expect(userFrom).toHaveBeenCalledWith('diagnostic_latest_results');
    expect(userFrom).toHaveBeenCalledWith('diagnostic_results');
    expect(userRpc).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
    expect(adminRpc.mock.calls.map(([name]) => name)).toEqual([
      'atomic_pre_deduct',
      'atomic_refund',
    ]);
    expect(diagnosticInsert).toHaveBeenCalledTimes(1);
  });

  it('locks the C7 routing and run_diag constructor wiring', () => {
    const trpcSource = readFileSync(new URL('../../trpc.ts', import.meta.url), 'utf8');
    const routerSource = readFileSync(new URL('../../routers/diagnostics.ts', import.meta.url), 'utf8');
    const runDiagSource = readFileSync(new URL('../../../run_diag.ts', import.meta.url), 'utf8');

    expect(trpcSource).toContain('supabase: userScopedSupabase,\n      userScopedSupabase,');
    expect(trpcSource).toContain(
      'supabase: ctx.supabaseAdmin,\n      userScopedSupabase: ctx.userScopedSupabase,',
    );
    expect(routerSource.match(/supabase: ctx\.userScopedSupabase,/g) ?? []).toHaveLength(9);
    expect(routerSource).not.toContain('supabase: ctx.supabase,');
    expect(routerSource).toContain('getDiagnosticsHealthCheck(ctx.userScopedSupabase)');
    expect(routerSource).toContain('getRecentRunsData(ctx.userScopedSupabase');
    expect(routerSource).toContain("await ctx.userScopedSupabase\n        .from('diagnostic_results')");
    expect(runDiagSource).toContain(
      'supabase: supabase as any,\n        supabaseAdmin: supabase as any,',
    );
  });
});
