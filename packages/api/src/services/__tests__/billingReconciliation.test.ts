import { describe, it, expect } from 'vitest';
import {
  buildBillingEngineV15ReadinessAudit,
  runDailyBillingReconciliation,
} from '../billingReconciliation';

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

function createReadinessRows(overrides: Partial<Parameters<typeof buildBillingEngineV15ReadinessAudit>[0]> = {}) {
  const baseRows: Parameters<typeof buildBillingEngineV15ReadinessAudit>[0] = {
    profiles: [
      { id: 'user-ready', credits: 120 },
    ],
    creditTransactions: [
      {
        id: 'txn-subscription-grant',
        user_id: 'user-ready',
        amount: 100,
        ledger_type: 'grant',
        reason_code: 'annual_monthly_release',
        counts_as_spend: false,
        grant_period_key: 'sub-ready:2026-06:01',
        idempotency_key: 'subscription_grant:annual_monthly_release:sub-ready:sub-ready:2026-06:01',
      },
      {
        id: 'txn-ai-spend',
        user_id: 'user-ready',
        amount: -10,
        ledger_type: 'spend',
        reason_code: 'ai_task_spend',
        counts_as_spend: true,
      },
      {
        id: 'txn-refund-clawback',
        user_id: 'user-ready',
        amount: -20,
        ledger_type: 'refund_clawback',
        reason_code: 'refund_clawback',
        counts_as_spend: false,
      },
      {
        id: 'txn-topup',
        user_id: 'user-ready',
        amount: 50,
        ledger_type: 'grant',
        reason_code: 'topup_purchase',
        source_type: 'stripe_checkout',
        counts_as_spend: false,
      },
    ],
    paymentOrders: [
      {
        id: 'order-completed',
        user_id: 'user-ready',
        item_type: 'membership_plan',
        mode: 'subscription',
        status: 'completed',
        payment_status: 'paid',
        fulfilled_at: '2026-06-15T00:00:00.000Z',
        created_at: '2026-06-15T00:00:00.000Z',
        stripe_subscription_id: 'sub-ready',
        stripe_invoice_id: 'in-ready',
      },
      {
        id: 'order-refunded',
        user_id: 'user-ready',
        item_type: 'membership_plan',
        mode: 'subscription',
        status: 'refunded',
        payment_status: 'refunded',
        fulfilled_at: '2026-06-10T00:00:00.000Z',
        created_at: '2026-06-10T00:00:00.000Z',
        stripe_subscription_id: 'sub-ready',
        stripe_invoice_id: 'in-refunded',
        metadata: {
          subscriptionCreditGrantReversal: {
            fullRefund: true,
            reviewRequired: false,
            refundId: 're-ready',
            idempotencyKey: 'stripe_refund:subscription_grants:invoice:in-refunded:sub-ready',
          },
        },
      },
    ],
    subscriptionCreditGrants: [
      {
        id: 'grant-ready',
        user_id: 'user-ready',
        stripe_subscription_id: 'sub-ready',
        stripe_invoice_id: 'in-ready',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: 'sub-ready:2026-06:01',
        period_index: 1,
        total_periods: 12,
        credits_granted: 100,
        status: 'granted',
        idempotency_key: 'subscription_grant:annual_monthly_release:sub-ready:sub-ready:2026-06:01',
        credit_transaction_id: 'txn-subscription-grant',
      },
    ],
    subscriptions: [
      {
        id: 'subscription-ready',
        user_id: 'user-ready',
        stripe_subscription_id: 'sub-ready',
        status: 'active',
        billing_cycle: 'yearly',
        cancel_at_period_end: false,
        current_period_end: '2027-06-15T00:00:00.000Z',
      },
    ],
    truncatedTables: [],
  };

  return {
    ...baseRows,
    ...overrides,
  };
}

describe('buildBillingEngineV15ReadinessAudit', () => {
  it('passes a clean PR7 source-code readiness snapshot', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows(), {
      now: new Date('2026-06-15T12:00:00.000Z'),
    });

    expect(result.success).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toMatchObject({
      profilesScanned: 1,
      creditTransactionsScanned: 4,
      paymentOrdersScanned: 2,
      subscriptionCreditGrantsScanned: 1,
      subscriptionsScanned: 1,
      profileLedgerMismatches: 0,
      grantLedgerMismatches: 0,
      refundAuditGaps: 0,
    });
  });

  it('flags profile drift, bad payment status, stale pending orders, refund audit gaps, and duplicate active subscriptions', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows({
      profiles: [
        { id: 'user-ready', credits: 999 },
      ],
      paymentOrders: [
        {
          id: 'order-invalid',
          user_id: 'user-ready',
          item_type: 'membership_plan',
          mode: 'subscription',
          status: 'paid',
          created_at: '2026-06-10T00:00:00.000Z',
          stripe_subscription_id: 'sub-ready',
        },
        {
          id: 'order-stale-pending',
          user_id: 'user-ready',
          item_type: 'credit_package',
          mode: 'payment',
          status: 'pending',
          created_at: '2026-06-10T00:00:00.000Z',
        },
        {
          id: 'order-refund-missing-audit',
          user_id: 'user-ready',
          item_type: 'membership_plan',
          mode: 'subscription',
          status: 'partially_refunded',
          payment_status: 'partial_refunded',
          created_at: '2026-06-10T00:00:00.000Z',
          stripe_subscription_id: 'sub-ready',
          stripe_invoice_id: 'in-missing-refund-audit',
          metadata: {},
        },
      ],
      subscriptions: [
        {
          id: 'subscription-active-a',
          user_id: 'user-ready',
          stripe_subscription_id: 'sub-active-a',
          status: 'active',
          current_period_end: '2027-06-15T00:00:00.000Z',
        },
        {
          id: 'subscription-active-b',
          user_id: 'user-ready',
          stripe_subscription_id: 'sub-active-b',
          status: 'active',
          current_period_end: '2027-06-15T00:00:00.000Z',
        },
      ],
    }), {
      now: new Date('2026-06-15T12:00:00.000Z'),
      pendingOrderMaxAgeHours: 48,
    });

    expect(result.success).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'profile_ledger_balance_mismatch',
      'invalid_payment_order_status',
      'stale_pending_payment_order',
      'subscription_refund_audit_metadata_missing',
      'duplicate_active_subscription',
    ]));
    expect(result.summary).toMatchObject({
      profileLedgerMismatches: 1,
      invalidPaymentOrderStatuses: 1,
      stalePendingPaymentOrders: 2,
      refundAuditGaps: 1,
      duplicateActiveSubscriptionGroups: 1,
    });
  });

  it('flags subscription grant ledger mismatches, annual duplicates, refund clawback spend flags, and duplicate idempotency keys', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows({
      creditTransactions: [
        {
          id: 'txn-subscription-grant',
          user_id: 'user-ready',
          amount: 120,
          ledger_type: 'grant',
          reason_code: 'bonus_grant',
          counts_as_spend: false,
          grant_period_key: 'wrong-period',
          idempotency_key: 'duplicate-key',
        },
        {
          id: 'txn-refund-clawback',
          user_id: 'user-ready',
          amount: -20,
          ledger_type: 'refund_clawback',
          reason_code: 'refund_clawback',
          counts_as_spend: true,
          idempotency_key: 'duplicate-key',
        },
        {
          id: 'txn-orphan-subscription-grant',
          user_id: 'user-ready',
          amount: 100,
          ledger_type: 'grant',
          reason_code: 'subscription_grant',
          counts_as_spend: false,
          idempotency_key: 'subscription_grant:monthly:in-orphan',
        },
      ],
      subscriptionCreditGrants: [
        {
          id: 'grant-ready-a',
          user_id: 'user-ready',
          stripe_subscription_id: 'sub-ready',
          stripe_invoice_id: 'in-ready',
          billing_cycle: 'monthly',
          grant_type: 'annual_monthly_release',
          grant_period_key: 'sub-ready:2026-06:01',
          period_index: 13,
          total_periods: 1,
          credits_granted: 100,
          status: 'granted',
          idempotency_key: 'duplicate-grant-key',
          credit_transaction_id: 'txn-subscription-grant',
        },
        {
          id: 'grant-ready-b',
          user_id: 'user-ready',
          stripe_subscription_id: 'sub-ready',
          stripe_invoice_id: 'in-ready',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: 'sub-ready:2026-06:01',
          period_index: 1,
          total_periods: 12,
          credits_granted: 100,
          status: 'granted',
          idempotency_key: 'duplicate-grant-key',
          credit_transaction_id: 'txn-missing',
        },
      ],
    }), {
      now: new Date('2026-06-15T12:00:00.000Z'),
    });

    expect(result.success).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'subscription_grant_credit_transaction_mismatch',
      'subscription_grant_missing_credit_transaction',
      'annual_monthly_release_period_invalid',
      'subscription_grant_transaction_orphaned',
      'duplicate_annual_grant_period',
      'refund_clawback_counts_as_spend',
      'duplicate_idempotency_key',
    ]));
    expect(result.summary).toMatchObject({
      grantLedgerMismatches: 4,
      duplicateAnnualGrantPeriods: 1,
      refundAuditGaps: 1,
      duplicateIdempotencyKeys: 2,
    });
  });

  it('does not emit profile balance errors when ledger or profile scans are truncated', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows({
      profiles: [
        { id: 'user-ready', credits: 999 },
      ],
      truncatedTables: ['credit_transactions'],
    }), {
      now: new Date('2026-06-15T12:00:00.000Z'),
      rowLimit: 1,
    });

    expect(result.success).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'readiness_scan_truncated',
        severity: 'warning',
        entityType: 'credit_transactions',
      }),
    ]);
    expect(result.summary.profileLedgerMismatches).toBe(0);
    expect(result.summary.truncatedTables).toEqual(['credit_transactions']);
  });

  it('requires subscription grant credit transactions to preserve the grant period key', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows({
      creditTransactions: [
        {
          id: 'txn-subscription-grant',
          user_id: 'user-ready',
          amount: 100,
          ledger_type: 'grant',
          reason_code: 'annual_monthly_release',
          counts_as_spend: false,
          idempotency_key: 'subscription_grant:annual_monthly_release:sub-ready:sub-ready:2026-06:01',
        },
        {
          id: 'txn-ai-spend',
          user_id: 'user-ready',
          amount: -10,
          ledger_type: 'spend',
          reason_code: 'ai_task_spend',
          counts_as_spend: true,
        },
        {
          id: 'txn-refund-clawback',
          user_id: 'user-ready',
          amount: -20,
          ledger_type: 'refund_clawback',
          reason_code: 'refund_clawback',
          counts_as_spend: false,
        },
        {
          id: 'txn-topup',
          user_id: 'user-ready',
          amount: 50,
          ledger_type: 'grant',
          reason_code: 'topup_purchase',
          source_type: 'stripe_checkout',
          counts_as_spend: false,
        },
      ],
    }), {
      now: new Date('2026-06-15T12:00:00.000Z'),
    });

    expect(result.success).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'subscription_grant_credit_transaction_mismatch',
        entityId: 'grant-ready',
        metadata: expect.objectContaining({
          grantPeriodKey: 'sub-ready:2026-06:01',
          transactionGrantPeriodKey: null,
        }),
      }),
    ]));
    expect(result.summary.grantLedgerMismatches).toBe(1);
  });

  it('counts payment-attention subscription rows when detecting duplicate managed subscriptions', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows({
      subscriptions: [
        {
          id: 'subscription-active',
          user_id: 'user-ready',
          stripe_subscription_id: 'sub-active',
          status: 'active',
          current_period_end: '2027-06-15T00:00:00.000Z',
        },
        {
          id: 'subscription-past-due',
          user_id: 'user-ready',
          stripe_subscription_id: 'sub-past-due',
          status: 'past_due',
          current_period_end: '2027-06-15T00:00:00.000Z',
        },
      ],
    }), {
      now: new Date('2026-06-15T12:00:00.000Z'),
    });

    expect(result.success).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'duplicate_active_subscription',
        entityId: 'user-ready',
        metadata: expect.objectContaining({
          stripeSubscriptionIds: ['sub-active', 'sub-past-due'],
        }),
      }),
    ]));
    expect(result.summary.duplicateActiveSubscriptionGroups).toBe(1);
  });

  it('scopes credit transaction idempotency duplicate checks by user', () => {
    const result = buildBillingEngineV15ReadinessAudit(createReadinessRows({
      profiles: [
        { id: 'user-ready', credits: 120 },
        { id: 'user-other', credits: 5 },
      ],
      creditTransactions: [
        {
          id: 'txn-subscription-grant',
          user_id: 'user-ready',
          amount: 100,
          ledger_type: 'grant',
          reason_code: 'annual_monthly_release',
          counts_as_spend: false,
          grant_period_key: 'sub-ready:2026-06:01',
          idempotency_key: 'subscription_grant:annual_monthly_release:sub-ready:sub-ready:2026-06:01',
        },
        {
          id: 'txn-ai-spend',
          user_id: 'user-ready',
          amount: -10,
          ledger_type: 'spend',
          reason_code: 'ai_task_spend',
          counts_as_spend: true,
        },
        {
          id: 'txn-refund-clawback',
          user_id: 'user-ready',
          amount: -20,
          ledger_type: 'refund_clawback',
          reason_code: 'refund_clawback',
          counts_as_spend: false,
        },
        {
          id: 'txn-topup',
          user_id: 'user-ready',
          amount: 50,
          ledger_type: 'grant',
          reason_code: 'topup_purchase',
          source_type: 'stripe_checkout',
          counts_as_spend: false,
          idempotency_key: 'shared-cross-user-key',
        },
        {
          id: 'txn-other-user-topup',
          user_id: 'user-other',
          amount: 5,
          ledger_type: 'grant',
          reason_code: 'topup_purchase',
          source_type: 'stripe_checkout',
          counts_as_spend: false,
          idempotency_key: 'shared-cross-user-key',
        },
      ],
    }), {
      now: new Date('2026-06-15T12:00:00.000Z'),
    });

    expect(result.success).toBe(true);
    expect(result.summary.duplicateIdempotencyKeys).toBe(0);
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'duplicate_idempotency_key',
        entityType: 'credit_transactions',
      }),
    ]));
  });
});
