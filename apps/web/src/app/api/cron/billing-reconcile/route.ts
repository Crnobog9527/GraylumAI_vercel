import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  runBillingEngineV15ReadinessAudit,
  runDailyBillingReconciliation,
} from '@repo/api/src/services/billingReconciliation';
import { logger } from '@repo/api/src/services';
import { runErasureFinancialReconciliation } from '@repo/api/src/services/accountErasure/financialRecovery';
import { reconcileWaffoPayments } from '@repo/api/src/services/payments/waffoReconciliation';
import { getWaffoTestOperationsClient } from '@repo/api/src/services/payments/waffoTestOperationsClient';
import { closeExpiredWaffoCheckouts } from '@repo/api/src/services/payments/waffoCardCheckout';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_FAILURE_MESSAGE = 'Billing reconciliation failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';

/** Waffo daily backstop: report-only. Off until the test operations binding is explicitly enabled. */
async function runWaffoReconciliation(supabase: SupabaseClient) {
  if (process.env.WAFFO_TEST_OPERATIONS_ENABLED !== 'true') return { success: true, skipped: true, findings: [] };
  try {
    const provider = getWaffoTestOperationsClient();
    // Lifecycle only: release unpaid card orders past their checkout window (late cash stays review).
    const closedExpired = await closeExpiredWaffoCheckouts(supabase, provider.merchant);
    return { ...await reconcileWaffoPayments(supabase, provider), closedExpired, skipped: false };
  } catch {
    return { success: false, skipped: false, findings: [{ kind: 'scan_failed', refundCandidate: false }] };
  }
}

export async function GET(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'billing-reconcile');
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const startedAt = Date.now();

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: CRON_CONFIG_ERROR_MESSAGE }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    logger.system.cronJob('billing-reconcile', 'started');
    const [result, readinessAudit, erasureFinancial, waffo] = await Promise.all([
      runDailyBillingReconciliation(supabase),
      runBillingEngineV15ReadinessAudit(supabase),
      runErasureFinancialReconciliation(supabase),
      runWaffoReconciliation(supabase),
    ]);
    const success = result.success && readinessAudit.success && erasureFinancial.success && waffo.success;

    if (!success) {
      logger.system.cronJob(
        'billing-reconcile',
        'failed',
        Date.now() - startedAt,
        [...result.mismatches, ...readinessAudit.findings.map((finding) => finding.message),
          ...(erasureFinancial.success ? [] : ['Erasure financial recovery pending']),
          ...(waffo.success ? [] : [`Waffo payments need manual review: ${waffo.findings.length}`])].join(' | '),
        {
          erasureFinancial,
          waffo,
          mismatches: result.mismatches,
          summary: result.summary,
          readinessAudit: {
            checkedAt: readinessAudit.checkedAt,
            summary: readinessAudit.summary,
            findings: readinessAudit.findings,
          },
        },
      );
    } else {
      logger.system.cronJob(
        'billing-reconcile',
        'completed',
        Date.now() - startedAt,
        undefined,
        {
          erasureFinancial,
          summary: result.summary,
          readinessAudit: {
            checkedAt: readinessAudit.checkedAt,
            summary: readinessAudit.summary,
          },
        },
      );
    }

    return NextResponse.json({
      success,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      mismatches: result.mismatches,
      summary: result.summary,
      readinessAudit,
      erasureFinancial,
      waffo,
      timestamp: new Date().toISOString(),
    }, { status: success ? 200 : 500 });
  } catch (error) {
    logger.system.cronJob(
      'billing-reconcile',
      'failed',
      Date.now() - startedAt,
      '账单对账失败，请查看服务端日志',
    );

    return NextResponse.json({
      success: false,
      error: CRON_FAILURE_MESSAGE,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
