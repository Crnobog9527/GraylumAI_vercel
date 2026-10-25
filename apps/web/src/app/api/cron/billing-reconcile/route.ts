import { recoverWaffoOneTimeCheckouts } from '@repo/api/src/services/payments/waffoOneTimeRecovery';
import { afterWaffoFulfillment } from '@repo/api/src/services/payments/failoverAfterFulfillment';
import { reconcileFailoverRefunds } from '@repo/api/src/services/payments/failoverReconciliation';
import { paymentDeploymentMode, assertWaffoWebhookEnvironment } from '@repo/api/src/services/payments/methodCheckoutGate';
import { reportPaymentDispute } from '@/lib/payment-dispute-alert.mjs';
import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  runBillingEngineV15ReadinessAudit,
  runDailyBillingReconciliation,
} from '@repo/api/src/services/billingReconciliation';
import { logger } from '@repo/api/src/services';
import { runErasureFinancialReconciliation } from '@repo/api/src/services/accountErasure/financialRecovery';
import { reconcileWaffoPayments } from '@repo/api/src/services/payments/waffoReconciliation';
import { getWaffoTestOperationsClient, getWaffoOperationsClient } from '@repo/api/src/services/payments/waffoTestOperationsClient';
import { closeExpiredWaffoCheckouts } from '@repo/api/src/services/payments/waffoCardCheckout';
import { describeWaffoFailure } from '@repo/api/src/services/payments/waffoFailure';
import { findStaleChargedRounds } from '@repo/api/src/services/runtime/staleChargedRounds';
import { reconcileStripeCardPayments } from '@repo/api/src/services/payments/stripeCardReconciliation';
import { getStripeClient } from '@repo/api/src/services/stripe';
import { reportPaymentEvidenceConflict, reportStripeCardReconciliation } from '@/lib/payment-alert.mjs';
import { recoverFusionFinancials } from '@repo/api/src/services/fusion/recovery';
import { recoverVoiceGenerations } from '@repo/api/src/services/voice/recovery';
import { settleDueReportFees } from '@repo/api/src/services/report/fees';
import { findStuckPaygCalls } from '@repo/api/src/services/bill2/stuckCalls';
import { kickStalledReviews } from '@repo/api/src/services/fusion/background';
import { validateCronRequest } from '@/lib/cron-auth';
import { pruneGaCheckoutIds } from '@repo/api/src/services/analytics/gaPurchase';
import { refreshResearchPrices } from '@repo/api/src/services/research/priceRefresh';
import { platformSecretReader } from '@repo/api/src/services/research/runtime/secrets';
import { stagingRuntimeWindow } from '@repo/api/src/services/runtime/stagingEnvironment';

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

/** VOICE: settle generations whose page closed before they finished; scrub runs whose source document was deleted. */
async function runVoiceRecovery(supabase: SupabaseClient) {
  try { return await recoverVoiceGenerations(supabase); }
  catch { return { success: false, settled: 0, scrubbed: 0, waiting: 0, failed: 1 }; }
}

/** REPORT fixed price (0295): settle held prices of report executions that have ended. */
async function runReportFeeSettlement(supabase: SupabaseClient) {
  try { return await settleDueReportFees(supabase); }
  catch { return { success: false, settled: 0 }; }
}

/** FUSION-BACKGROUND daily backstop: reviews that stopped moving get one fresh step each (each at most once a day).
 * The step itself runs in its own invocation; this only asks for it, within a short time limit. */
async function runFusionKick(supabase: SupabaseClient, origin: string) {
  try { return await kickStalledReviews(supabase, origin, { timeLimitMs: 10_000 }); }
  catch { return { success: false, kicked: 0 }; }
}

/** Research prices expire (TikHub after 7 days): re-read TikHub's official prices daily, alert before any price expires. */
async function runResearchPriceRefresh(supabase: SupabaseClient) {
  let windowId: string | null = null;
  // Only the bound staging deployment has a test window whose tool policies follow the prices.
  try { windowId = stagingRuntimeWindow(process.env, true); } catch { windowId = null; }
  try {
    const read = platformSecretReader(supabase);
    return await refreshResearchPrices(supabase, { readKey: () => read('tikhub'), windowId });
  } catch {
    return { success: false, refreshed: [], changed: [], failed: [{ route: '*', code: 'UNEXPECTED' }], expiring: [], window: 'skipped' as const };
  }
}

/** Waffo daily backstop: report-only. Off until the test operations binding is explicitly enabled. */
// 0261: stuck calls keep this daily job failing (alerting) until an administrator settles them.
async function runStuckCallScan(supabase: SupabaseClient) {
  try { return await findStuckPaygCalls(supabase); }
  catch { return { success: false, calls: [], total: 0, truncated: false, scanFailed: true }; }
}

async function runWaffoReconciliation(supabase: SupabaseClient) {
  const mode = paymentDeploymentMode();
  if (mode === 'test' ? process.env.WAFFO_TEST_OPERATIONS_ENABLED !== 'true' : !process.env.WAFFO_MERCHANT_NAMESPACE) {
    return { success: true, skipped: true, findings: [] };
  }
  try {
    assertWaffoWebhookEnvironment();
    const deadline = Date.now() + 45_000;
    const provider = mode === 'test' ? getWaffoTestOperationsClient({ deadline }) : getWaffoOperationsClient('live', { deadline });
    // Legacy recurring checkout expiry remains separate; one-time orders require original-provider proof.
    const closedExpired = await closeExpiredWaffoCheckouts(supabase, provider.merchant, undefined, mode);
    const recovered = await recoverWaffoOneTimeCheckouts(supabase, provider, undefined,
      orderId => afterWaffoFulfillment(supabase, orderId, deadline), deadline);
    const refunds = await reconcileFailoverRefunds(supabase, provider, deadline);
    const payments = await reconcileWaffoPayments(supabase, provider, { recover: true, deadline, disputeAlert: reportPaymentDispute,
      afterFulfillment: orderId => afterWaffoFulfillment(supabase, orderId, deadline) });
    return { ...payments, success: payments.success && refunds.success && recovered.blocked.length === 0,
      findings: [...payments.findings, ...refunds.findings,
        ...recovered.blocked.map(orderId => ({ kind: 'checkout_unresolved', orderId, refundCandidate: false }))],
      closedExpired: closedExpired + recovered.closed, skipped: false };
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
      reconcileStripeCardPayments(supabase, stripe, { expectedMode,
        alert: () => reportPaymentEvidenceConflict('billing-reconcile'), disputeAlert: reportPaymentDispute }),
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
    // ANALYTICS 0280: GA checkout ids never taken (long past their 45-minute window) are deleted (statistics only, never fails the job).
    const analyticsIds = pruneGaCheckoutIds(supabase);
    const [result, readinessAudit, erasureFinancial, waffo, staleRounds, stripeCard, { fusion, fusionKick }, stuckCalls, reportFees,
      voice, researchPrices] = await Promise.all([
      runDailyBillingReconciliation(supabase),
      runBillingEngineV15ReadinessAudit(supabase),
      runErasureFinancialReconciliation(supabase),
      runWaffoReconciliation(supabase),
      runStaleRoundReconciliation(supabase),
      runStripeCardReconciliation(supabase),
      (async () => {
        // Kick before recovery resets idle timestamps; do not delay the independent financial audits.
        const fusionKick = await runFusionKick(supabase, new URL(request.url).origin);
        return { fusionKick, fusion: await runFusionRecovery(supabase) };
      })(),
      runStuckCallScan(supabase),
      runReportFeeSettlement(supabase),
      runVoiceRecovery(supabase),
      runResearchPriceRefresh(supabase),
    ]);
    const success = result.success && readinessAudit.success && erasureFinancial.success && waffo.success
      && staleRounds.success && stripeCard.success && fusion.success && fusionKick.success && stuckCalls.success
      && reportFees.success && voice.success && researchPrices.success;

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
          ...(stuckCalls.success ? [] : [`PAYG calls with unknown cost need manual settlement: ${stuckCalls.total}`]),
          ...(fusionKick.success ? [] : ['Fusion review kick failed']),
          ...(reportFees.success ? [] : ['Report price settlement failed']),
          ...(voice.success ? [] : [`Voice generations pending recovery: ${voice.failed}`]),
          ...(researchPrices.success ? [] : [`Research prices: ${researchPrices.failed.length} refresh failures, `
            + `${researchPrices.expiring.length} expiring within a day, window ${researchPrices.window}`])].join(' | '),
        {
          erasureFinancial,
          waffo,
          staleRounds,
          stripeCard,
          fusion,
          stuckCalls,
          fusionKick,
          reportFees,
          voice,
          researchPrices,
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
      analyticsIds: await analyticsIds,
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
      fusionKick,
      reportFees,
      voice,
      researchPrices,
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
