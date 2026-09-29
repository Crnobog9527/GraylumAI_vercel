import type { SupabaseClient } from '@supabase/supabase-js';
import type { DiagnosticContext, DiagnosticTestResult } from './diagnostics';
import { runDailyBillingReconciliation } from './billingReconciliation';

// These probes only inspect readable schema. A SELECT cannot prove atomic
// deduction or concurrent idempotency; those require isolated integration tests.
async function inspectBillingSchema(
  client: SupabaseClient, testId: string, testName: string, columns: string,
): Promise<DiagnosticTestResult> {
  const started = Date.now();
  const base = { testId, testName, category: 'billing' as const };
  try {
    const { error } = await client.from('billing_history').select(columns).limit(0);
    if (error) throw error;
    return {
      ...base, status: 'warning', latencyMs: Date.now() - started,
      message: '只读字段检查完成；未执行扣费或并发重试，不能证明预扣或幂等性通过。',
      details: { mode: 'read_only', schemaReadable: true, liveBillingVerified: false },
    };
  } catch {
    return {
      ...base, status: 'failed', latencyMs: Date.now() - started,
      message: '计费记录只读检查失败：查询不可用或所需字段不可读取。',
      details: { mode: 'read_only', schemaReadable: false, liveBillingVerified: false },
    };
  }
}

export function testBillingPrededuct(ctx: DiagnosticContext) {
  return inspectBillingSchema(ctx.supabase, 'billing_prededuct', '预扣记录只读检查',
    'user_id, operation_type, amount, created_at');
}

export function testBillingIdempotency(ctx: DiagnosticContext) {
  // Migration 0103 grants service_role read access to id/metadata; 0079 excludes
  // these columns from authenticated reads. LIMIT 0 never returns billing rows.
  return inspectBillingSchema(ctx.supabaseAdmin, 'billing_idempotency', '幂等字段只读检查', 'id, metadata');
}

export async function testBillingReconcile(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const started = Date.now();
  const base = { testId: 'billing_reconcile', testName: '余额对账测试', category: 'billing' as const };
  try {
    // Existing reconciliation reads records and the read-only research summary RPC.
    const result = await runDailyBillingReconciliation(ctx.supabase);
    const valid = result.success && result.status === 'SUCCESS' && result.mismatches.length === 0;
    return {
      ...base, status: valid ? 'passed' : 'failed', latencyMs: Date.now() - started,
      message: valid ? '只读对账通过（仅覆盖所列期间和现有对账规则）。'
        : result.status === 'BLOCKED' ? '只读对账未通过：对账基线缺失或无效。'
          : `只读对账失败：发现 ${result.mismatches.length} 条异常。`,
      details: { mode: 'read_only', ...result },
    };
  } catch {
    return {
      ...base, status: 'failed', latencyMs: Date.now() - started,
      message: '只读对账失败：无法完整读取对账所需数据。',
      details: { mode: 'read_only' },
    };
  }
}
