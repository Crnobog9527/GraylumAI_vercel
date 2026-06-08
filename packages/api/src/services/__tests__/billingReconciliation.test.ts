import { describe, it, expect } from 'vitest';
import { runDailyBillingReconciliation } from '../billingReconciliation';

function createMockSupabase(data: {
  tokenStats?: Array<Record<string, unknown>>;
  aiUsageLogs?: Array<Record<string, unknown>>;
  billingHistory?: Array<Record<string, unknown>>;
  creditTransactions?: Array<Record<string, unknown>>;
  paymentOrders?: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    token_stats: data.tokenStats ?? [],
    ai_usage_logs: data.aiUsageLogs ?? [],
    billing_history: data.billingHistory ?? [],
    credit_transactions: data.creditTransactions ?? [],
    payment_orders: data.paymentOrders ?? [],
  };

  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    lt: async () => ({ data: tables[currentTable] ?? [], error: null }),
  };

  let currentTable = '';

  return {
    from: (table: string) => {
      currentTable = table;
      return builder;
    },
  } as any;
}

describe('runDailyBillingReconciliation', () => {
  it('passes when AI usage, token stats, billing history, and deductions match', async () => {
    const supabase = createMockSupabase({
      tokenStats: [
        { total_credits: 120, web_search_count: 1 },
        { total_credits: 80, web_search_count: 0 },
      ],
      aiUsageLogs: [
        { status: 'success' },
        { status: 'success' },
      ],
      billingHistory: [
        { operation_type: 'settle', amount: -120 },
        { operation_type: 'settle', amount: -80 },
      ],
      creditTransactions: [
        { type: 'deduction', amount: -120, description: 'AI 对话消费' },
        { type: 'deduction', amount: -80, description: 'AI 对话消费' },
        {
          type: 'deduction',
          amount: -999,
          description: '积分消费',
          idempotency_key: 'admin_credit_deduction:admin-1:manual-1',
        },
        { type: 'deduction', amount: -50, ledger_type: 'refund_clawback', counts_as_spend: false },
      ],
      paymentOrders: [],
    });

    const result = await runDailyBillingReconciliation(supabase, new Date('2026-03-10T00:00:00Z'));

    expect(result.success).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    expect(result.summary.successfulAiRequests).toBe(2);
    expect(result.summary.tokenStatsCredits).toBe(200);
    expect(result.summary.deductionCredits).toBe(200);
    expect(result.summary.webSearchCount).toBe(1);
  });

  it('reports mismatches when payment fulfillment or credit settlement drift', async () => {
    const supabase = createMockSupabase({
      tokenStats: [
        { total_credits: 100, web_search_count: 0 },
      ],
      aiUsageLogs: [
        { status: 'success' },
        { status: 'success' },
      ],
      billingHistory: [
        { operation_type: 'settle', amount: -40 },
      ],
      creditTransactions: [
        { type: 'deduction', amount: -40, description: 'AI 对话消费' },
      ],
      paymentOrders: [
        { status: 'completed', amount_total: 1999 },
      ],
    });

    const result = await runDailyBillingReconciliation(supabase, new Date('2026-03-10T00:00:00Z'));

    expect(result.success).toBe(false);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AI success logs'),
        expect.stringContaining('Billing settle credits'),
        expect.stringContaining('Credit deductions'),
        expect.stringContaining('Completed payment orders'),
      ]),
    );
  });

  it('reports completed payment orders as unmatched when the only same-day credit is a check-in grant', async () => {
    const supabase = createMockSupabase({
      creditTransactions: [
        {
          type: 'addition',
          amount: 10,
          ledger_type: 'grant',
          reason_code: 'checkin',
          source_type: 'system',
        },
      ],
      paymentOrders: [
        { status: 'completed', amount_total: 1999 },
      ],
    });

    const result = await runDailyBillingReconciliation(supabase, new Date('2026-03-10T00:00:00Z'));

    expect(result.success).toBe(false);
    expect(result.summary.purchaseCredits).toBe(0);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Completed payment orders'),
      ]),
    );
  });

  it('reports completed payment orders as unmatched when the only same-day credit is a subscription grant', async () => {
    const supabase = createMockSupabase({
      creditTransactions: [
        {
          type: 'addition',
          amount: 1500,
          ledger_type: 'grant',
          reason_code: 'subscription_grant',
          source_type: 'stripe_invoice',
        },
      ],
      paymentOrders: [
        { status: 'completed', amount_total: 1999 },
      ],
    });

    const result = await runDailyBillingReconciliation(supabase, new Date('2026-03-10T00:00:00Z'));

    expect(result.success).toBe(false);
    expect(result.summary.purchaseCredits).toBe(0);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Completed payment orders'),
      ]),
    );
  });

  it('accepts v2 top-up purchase credits for completed payment order reconciliation', async () => {
    const supabase = createMockSupabase({
      creditTransactions: [
        {
          type: 'addition',
          amount: 500,
          ledger_type: 'grant',
          reason_code: 'topup_purchase',
          source_type: 'stripe_checkout',
        },
      ],
      paymentOrders: [
        { status: 'completed', amount_total: 500 },
      ],
    });

    const result = await runDailyBillingReconciliation(supabase, new Date('2026-03-10T00:00:00Z'));

    expect(result.success).toBe(true);
    expect(result.summary.purchaseCredits).toBe(500);
    expect(result.mismatches).toHaveLength(0);
  });

  it('keeps legacy type purchase credits valid for completed payment order reconciliation', async () => {
    const supabase = createMockSupabase({
      creditTransactions: [
        {
          type: 'purchase',
          amount: 500,
        },
      ],
      paymentOrders: [
        { status: 'completed', amount_total: 500 },
      ],
    });

    const result = await runDailyBillingReconciliation(supabase, new Date('2026-03-10T00:00:00Z'));

    expect(result.success).toBe(true);
    expect(result.summary.purchaseCredits).toBe(500);
    expect(result.mismatches).toHaveLength(0);
  });
});
