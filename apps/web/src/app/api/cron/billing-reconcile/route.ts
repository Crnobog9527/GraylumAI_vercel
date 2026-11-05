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
import { reconcileStripeCardPayments } from '@repo/api/src/services/payments/stripeCardReconciliation';
import { getStripeClient } from '@repo/api/src/services/stripe';
import { reportPaymentEvidenceConflict, reportStripeCardReconciliation } from '@/lib/payment-alert.mjs';
import { recoverVoiceGenerations } from '@repo/api/src/services/voice/recovery';
import { kickStalledReviews } from '@repo/api/src/services/fusion/background';
import { startScheduledJobRun, finishScheduledJobRun } from '@repo/api/src/services/scheduledJobRuns';
import { logSwallowed, swallow } from '@repo/api/src/lib/swallow';
import { validateCronRequest } from '@/lib/cron-auth';
import { pruneGaCheckoutIds } from '@repo/api/src/services/analytics/gaPurchase';
import { refreshResearchPrices } from '@repo/api/src/services/research/priceRefresh';
import { platformSecretReader } from '@repo/api/src/services/research/runtime/secrets';
import { stagingRuntimeWindow } from '@repo/api/src/services/turn/settings/stagingEnvironment';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_FAILURE_MESSAGE = 'Billing reconciliation failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';
const BILLING_RECONCILE_JOB_KEY = 'billing_reconcile';
// The route limit is 60 s. The two billing scans give up after 40 s with a failed result (instead of running into the limit
// and taking the whole function, the TikHub price refresh with it); the price refresh has its own cap; the run-record
// writes share what is left.
const SCAN_CAP_MS = 40_000;
const PRICE_REFRESH_CAP_MS = 45_000;
const RUN_RECORD_CAP_MS = 1_500;
const RUN_ERROR_MAX_CHARS = 500;

/** A step that has not answered in time is given up, never waited for: `fallback` is its failed result. */
function capStep<T>(step: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback()), ms); });
  return Promise.race([step, late]).finally(() => clearTimeout(timer));
}

/** A run-record write that has not answered in time is given up (null), never waited for. A failed or late write is logged
 * (and reaches Sentry), so a run without a record is never silent. */
function capped<T>(label: string, write: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => { logSwallowed(label, new Error('RUN_RECORD_TIMEOUT')); resolve(null); }, RUN_RECORD_CAP_MS);
  });
  return Promise.race([swallow(label, write, null), late]).finally(() => clearTimeout(timer));
}

const timedOutDaily = () => ({
  success: false, status: 'FAILED', launchBaselineAt: null, periodStart: null, periodEnd: null, enforcementStart: null,
  mismatches: ['Daily billing reconciliation timed out'], summary: {},
}) as unknown as Awaited<ReturnType<typeof runDailyBillingReconciliation>>;

const timedOutReadiness = () => ({
  success: false, status: 'FAILED', launchBaselineAt: null, checkedAt: new Date().toISOString(),
  findings: [{ code: 'billing_readiness_scan_timeout', severity: 'error', scope: 'launch', message: 'Billing readiness audit timed out' }],
  historicalFindings: [], summary: {}, options: {},
}) as unknown as Awaited<ReturnType<typeof runBillingEngineV15ReadinessAudit>>;

/** VOICE: settle generations whose page closed before they finished; scrub runs whose source document was deleted. */
async function runVoiceRecovery(supabase: SupabaseClient) {
  try { return await recoverVoiceGenerations(supabase); }
  catch { return { success: false, settled: 0, scrubbed: 0, waiting: 0, failed: 1 }; }
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
    return await capStep(refreshResearchPrices(supabase, { readKey: () => read('tikhub'), windowId }), PRICE_REFRESH_CAP_MS,
      () => ({ success: false, refreshed: [], changed: [], failed: [{ route: '*', code: 'TIMEOUT' }], expiring: [], window: 'skipped' as const }));
  } catch {
    return { success: false, refreshed: [], changed: [], failed: [{ route: '*', code: 'UNEXPECTED' }], expiring: [], window: 'skipped' as const };
  }
}

/** Waffo daily backstop: report-only. Off until the test operations binding is explicitly enabled. */
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
  // Every run leaves a record in scheduled_job_runs (counts, and the reasons when it fails): without one a failing daily job
  // went unseen for days. A failed or late record write never changes the job's own result.
  let finishRun: (status: 'success' | 'error', summary: Record<string, unknown>, error?: string) => Promise<unknown> = async () => null;

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: CRON_CONFIG_ERROR_MESSAGE }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    logger.system.cronJob('billing-reconcile', 'started');
    const runId = await capped('billing_reconcile_run_record_start_failed',
      startScheduledJobRun({ supabase, jobKey: BILLING_RECONCILE_JOB_KEY, triggerSource: 'cron' }));
    finishRun = (status, summary, error) => runId
      ? capped('billing_reconcile_run_record_finish_failed', finishScheduledJobRun({ supabase, runId, status, summary, error })) : Promise.resolve(null);
    // ANALYTICS 0280: GA checkout ids never taken (long past their 45-minute window) are deleted (statistics only, never fails the job).
    const analyticsIds = pruneGaCheckoutIds(supabase);
    // CORE-PATH-V2 V2-12 B10: the stale charged rounds scan, the stuck PAYG calls scan and the receipt retention are gone (old BILL2
    // tools; the old rows go with their tables in batch F).
    const [result, readinessAudit, erasureFinancial, waffo, stripeCard, fusionKick,
      voice, researchPrices] = await Promise.all([
      capStep(runDailyBillingReconciliation(supabase), SCAN_CAP_MS, timedOutDaily),
      capStep(runBillingEngineV15ReadinessAudit(supabase), SCAN_CAP_MS, timedOutReadiness),
      runErasureFinancialReconciliation(supabase),
      runWaffoReconciliation(supabase),
      runStripeCardReconciliation(supabase),
      runFusionKick(supabase, new URL(request.url).origin),
      runVoiceRecovery(supabase),
      runResearchPriceRefresh(supabase),
    ]);
    const success = result.success && readinessAudit.success && erasureFinancial.success && waffo.success
      && stripeCard.success && fusionKick.success
      && voice.success && researchPrices.success;

    const failureReasons = [...new Set([...result.mismatches, ...readinessAudit.findings.map((finding) => finding.message),
          ...(erasureFinancial.success ? [] : ['Erasure financial recovery pending']),
          ...(waffo.success ? [] : [`Waffo payments need manual review: ${waffo.findings.length}`]),
          ...(stripeCard.success ? [] : [`Stripe card payments need manual review: ${stripeCard.findings.length}`]),

          ...(fusionKick.success ? [] : ['Fusion review kick failed']),
          ...(voice.success ? [] : [`Voice generations pending recovery: ${voice.failed}`]),
          ...(researchPrices.success ? [] : [`Research prices: ${researchPrices.failed.length} refresh failures, `
            + `${researchPrices.expiring.length} expiring within a day, window ${researchPrices.window}`])])];
    const readinessWarnings = readinessAudit.findings.filter((finding) => finding.severity === 'warning').map((finding) => finding.message);

    if (!success) {
      logger.system.cronJob(
        'billing-reconcile',
        'failed',
        Date.now() - startedAt,
        failureReasons.join(' | '),
        {
          erasureFinancial,
          waffo,
          stripeCard,
          fusionKick,
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
            warnings: readinessWarnings,
          },
        },
      );
    }

    const count = (items: unknown) => (Array.isArray(items) ? items.length : 0);
    await finishRun(success ? 'success' : 'error', {
      success,
      durationMs: Date.now() - startedAt,
      dailyMismatches: count(result.mismatches),
      readiness: {
        status: readinessAudit.status,
        errors: readinessAudit.findings.filter((finding) => finding.severity === 'error').length,
        warnings: readinessWarnings.length,
        historical: count(readinessAudit.historicalFindings),
        unresolvedReservations: readinessAudit.summary?.unresolvedReservations ?? null,
      },
      waffo: { success: waffo.success, skipped: Boolean((waffo as { skipped?: boolean }).skipped), findings: count(waffo.findings) },
      stripeCard: { success: stripeCard.success, skipped: Boolean((stripeCard as { skipped?: boolean }).skipped), findings: count(stripeCard.findings) },
      erasureFinancial: { success: erasureFinancial.success },
      fusionKick: { success: fusionKick.success },
      voice: { success: voice.success, failed: voice.failed },
      researchPrices: { success: researchPrices.success, refreshed: count(researchPrices.refreshed), failed: count(researchPrices.failed),
        expiring: count(researchPrices.expiring), window: researchPrices.window },
    }, success ? undefined : failureReasons.join(' | ').slice(0, RUN_ERROR_MAX_CHARS));

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
      stripeCard,
      fusionKick,
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
    await finishRun('error', { success: false, durationMs: Date.now() - startedAt }, 'BILLING_RECONCILE_FAILED');

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
