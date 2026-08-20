import { describe, expect, it, vi } from 'vitest';
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
