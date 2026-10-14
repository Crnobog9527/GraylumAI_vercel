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
import { describeWaffoFailure } from '@repo/api/src/services/payments/waffoFailure';
import { findStaleChargedRounds } from '@repo/api/src/services/runtime/staleChargedRounds';
import { reconcileStripeCardPayments } from '@repo/api/src/services/payments/stripeCardReconciliation';
import { getStripeClient } from '@repo/api/src/services/stripe';
import { reportPaymentEvidenceConflict, reportStripeCardReconciliation } from '@/lib/payment-alert.mjs';
import { recoverFusionFinancials } from '@repo/api/src/services/fusion/recovery';
import { findStuckPaygCalls } from '@repo/api/src/services/bill2/stuckCalls';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_FAILURE_MESSAGE = 'Billing reconciliation failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';

/** Stale charged rounds: report-only; an operator verifies and refunds each one (Owner 2026-10-12). */
async function runStaleRoundReconciliation(supabase: SupabaseClient) {
  try { return await findStaleChargedRounds(supabase); }
  catch { return { success: false, findings: [], total: 0, truncated: false, scanFailed: true }; }
}

/** FUSION-REVIEW: cancel undispatched calls past their dispatch deadline, recover and settle the rest. */
async function runFusionRecovery(supabase: SupabaseClient) {
  try { return await recoverFusionFinancials(supabase); }
  catch { return { success: false, scanned: 0, cancelled: 0, recovered: 0, scrubbed: 0, failed: 1 }; }
}

/** Waffo daily backstop: report-only. Off until the test operations binding is explicitly enabled. */
// 0261: stuck calls keep this daily job failing (alerting) until an administrator settles them.
async function runStuckCallScan(supabase: SupabaseClient) {
  try { return await findStuckPaygCalls(supabase); }
  catch { return { success: false, calls: [], total: 0, truncated: false, scanFailed: true }; }
}

async function runWaffoReconciliation(supabase: SupabaseClient) {
  if (process.env.WAFFO_TEST_OPERATIONS_ENABLED !== 'true') return { success: true, skipped: true, findings: [] };
  try {
    const provider = getWaffoTestOperationsClient();
    // Lifecycle only: release unpaid card orders past their checkout window (late cash stays review).
    const closedExpired = await closeExpiredWaffoCheckouts(supabase, provider.merchant);
    return { ...await reconcileWaffoPayments(supabase, provider), closedExpired, skipped: false };
  } catch (error) {
    logger.error('billing', 'pay_waffo_reconciliation_failed', describeWaffoFailure(error));
    return { success: false, skipped: false, findings: [{ kind: 'scan_failed', refundCandidate: false }] };
  }
}

/** PAY-STRIPE-MP: repairs card orders whose webhook was lost; unrepaired items alert. Off unless the environment sets
 * STRIPE_CARD_RECONCILIATION_MODE to the Stripe mode it must run with (staging: test; production: live, enabled only
 * with Owner approval at launch, REL-1). A key of the other mode is refused and alerted, never scanned. */
async function runStripeCardReconciliation(supabase: SupabaseClient) {
  const expectedMode = process.env.STRIPE_CARD_RECONCILIATION_MODE;
  if (!expectedMode) return { success: true, skipped: true, findings: [] };
  if (expectedMode !== 'test' && expectedMode !== 'live') {
    // A typo must not look like the intentional "off": it is a configuration failure, alerted.
    const findings = [{ kind: 'scan_failed' as const, code: 'STRIPE_CARD_RECONCILIATION_MODE_INVALID' }];
    reportStripeCardReconciliation(findings);
    return { success: false, skipped: false, findings };
  }
  let stripe;
  try { stripe = getStripeClient(); } catch {
    const findings = [{ kind: 'scan_failed' as const, code: 'STRIPE_NOT_CONFIGURED' }];
    reportStripeCardReconciliation(findings);
    return { success: false, skipped: false, findings };
  }
  try {
    // A stalled Stripe request (default timeout 80 s) must not outlive the cron's 60 s: stop waiting after 50 s and report
    // an incomplete scan. Work cut off mid-way is safe; every repair is idempotent and is retried the next day.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reconcileStripeCardPayments(supabase, stripe, { expectedMode, alert: () => reportPaymentEvidenceConflict('billing-reconcile') }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('STRIPE_CARD_RECONCILIATION_TIMEOUT')), 50_000); }),
    ]).finally(() => clearTimeout(timer));
    reportStripeCardReconciliation(result.findings);
    return result;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'UNEXPECTED';
    logger.error('billing', 'stripe_card_reconciliation_failed', { code });
    const findings = [{ kind: 'scan_failed' as const, code }];
    reportStripeCardReconciliation(findings);
    return { success: false, skipped: false, findings };
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
    const [result, readinessAudit, erasureFinancial, waffo, staleRounds, stripeCard, fusion, stuckCalls] = await Promise.all([
      runDailyBillingReconciliation(supabase),
      runBillingEngineV15ReadinessAudit(supabase),
      runErasureFinancialReconciliation(supabase),
      runWaffoReconciliation(supabase),
      runStaleRoundReconciliation(supabase),
      runStripeCardReconciliation(supabase),
      runFusionRecovery(supabase),
      runStuckCallScan(supabase),
    ]);
    const success = result.success && readinessAudit.success && erasureFinancial.success && waffo.success
      && staleRounds.success && stripeCard.success && fusion.success && stuckCalls.success;

    if (!success) {
      logger.system.cronJob(
        'billing-reconcile',
        'failed',
        Date.now() - startedAt,
        [...result.mismatches, ...readinessAudit.findings.map((finding) => finding.message),
          ...(erasureFinancial.success ? [] : ['Erasure financial recovery pending']),
          ...(waffo.success ? [] : [`Waffo payments need manual review: ${waffo.findings.length}`]),
          ...(staleRounds.success ? [] : [`Stale charged rounds need manual review: ${staleRounds.total}`]),
          ...(stripeCard.success ? [] : [`Stripe card payments need manual review: ${stripeCard.findings.length}`]),
          ...(fusion.success ? [] : [`Fusion calls pending recovery: ${fusion.failed}`]),
          ...(stuckCalls.success ? [] : [`PAYG calls with unknown cost need manual settlement: ${stuckCalls.total}`])].join(' | '),
        {
          erasureFinancial,
          waffo,
          staleRounds,
          stripeCard,
          fusion,
          stuckCalls,
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
      staleRounds,
      stripeCard,
      fusion,
      stuckCalls,
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
