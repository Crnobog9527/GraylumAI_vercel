import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  erasure: vi.fn(),
  runDailyBillingReconciliation: vi.fn(),
  runBillingEngineV15ReadinessAudit: vi.fn(),
  validateCronRequest: vi.fn(),
  cronJob: vi.fn(),
  waffo: vi.fn(),
  waffoRefunds: vi.fn(),
  waffoRecovery: vi.fn(),
  waffoClient: vi.fn(),
  closeExpired: vi.fn(),
  logError: vi.fn(),
  stripeCard: vi.fn(),
  stripeClient: vi.fn(),
  reportStripeCard: vi.fn(),
  fusionKick: vi.fn(),
  voice: vi.fn(),
  researchPrices: vi.fn(),
  startRun: vi.fn(),
  finishRun: vi.fn(),
}));

vi.mock('@repo/api/src/services/scheduledJobRuns', () => ({ startScheduledJobRun: mocks.startRun, finishScheduledJobRun: mocks.finishRun }));

vi.mock('@repo/api/src/services/payments/waffoReconciliation', () => ({ reconcileWaffoPayments: mocks.waffo }));
vi.mock('@repo/api/src/services/payments/waffoTestOperationsClient', () => ({ getWaffoTestOperationsClient: mocks.waffoClient, getWaffoOperationsClient: mocks.waffoClient }));
vi.mock('@repo/api/src/services/payments/stripeCardReconciliation', () => ({ reconcileStripeCardPayments: mocks.stripeCard }));
vi.mock('@repo/api/src/services/stripe', () => ({ getStripeClient: mocks.stripeClient }));
vi.mock('@/lib/payment-alert.mjs', () => ({ reportStripeCardReconciliation: mocks.reportStripeCard,
  reportPaymentEvidenceConflict: vi.fn() }));
vi.mock('@repo/api/src/services/voice/recovery', () => ({ recoverVoiceGenerations: mocks.voice }));
vi.mock('@repo/api/src/services/research/priceRefresh', () => ({ refreshResearchPrices: mocks.researchPrices }));
vi.mock('@repo/api/src/services/research/runtime/secrets', () => ({ platformSecretReader: () => async () => 'key' }));
vi.mock('@repo/api/src/services/fusion/background', () => ({ kickStalledReviews: mocks.fusionKick }));
vi.mock('@repo/api/src/services/payments/waffoCardCheckout', () => ({ closeExpiredWaffoCheckouts: mocks.closeExpired }));

vi.mock('@repo/api/src/services/payments/waffoOneTimeRecovery', () => ({ recoverWaffoOneTimeCheckouts: mocks.waffoRecovery }));
vi.mock('@repo/api/src/services/payments/failoverReconciliation', () => ({ reconcileFailoverRefunds: mocks.waffoRefunds }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@repo/api/src/services/billingReconciliation', () => ({
  runDailyBillingReconciliation: mocks.runDailyBillingReconciliation,
  runBillingEngineV15ReadinessAudit: mocks.runBillingEngineV15ReadinessAudit,
}));

vi.mock('@repo/api/src/services/accountErasure/financialRecovery', () => ({
  runErasureFinancialReconciliation: mocks.erasure,
}));

vi.mock('@repo/api/src/services', () => ({
  logger: {
    system: {
      cronJob: mocks.cronJob,
    },
    error: mocks.logError,
  },
}));

vi.mock('@/lib/cron-auth', () => ({
  validateCronRequest: mocks.validateCronRequest,
}));

import { GET } from './route';

const dailySuccess = {
  success: true,
  status: 'SUCCESS',
  launchBaselineAt: '2026-09-01T00:00:00.000Z',
  periodStart: '2026-09-02T00:00:00.000Z',
  periodEnd: '2026-09-03T00:00:00.000Z',
  enforcementStart: '2026-09-02T00:00:00.000Z',
  mismatches: [],
  summary: {},
};

const readinessSuccess = {
  success: true,
  status: 'SUCCESS',
  launchBaselineAt: '2026-09-01T00:00:00.000Z',
  checkedAt: '2026-09-03T04:00:00.000Z',
  findings: [],
  historicalFindings: [],
  summary: {},
  options: {},
};

describe('/api/cron/billing-reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.waffoRefunds.mockResolvedValue({ success: true, findings: [] });
    mocks.waffoRecovery.mockResolvedValue({ closed: 0, blocked: [] });
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    mocks.validateCronRequest.mockReturnValue(null);
    mocks.erasure.mockResolvedValue({ success: true, pending: 0, failed: 0 });
    mocks.createClient.mockReturnValue({ client: 'service-role' });
    mocks.runDailyBillingReconciliation.mockResolvedValue(dailySuccess);
    mocks.runBillingEngineV15ReadinessAudit.mockResolvedValue(readinessSuccess);
    vi.stubEnv('STRIPE_CARD_RECONCILIATION_MODE', 'test');
    mocks.stripeClient.mockReturnValue({ client: 'stripe' });
    mocks.stripeCard.mockResolvedValue({ success: true, skipped: true, findings: [] });
    mocks.fusionKick.mockResolvedValue({ success: true, kicked: 0, listed: 0 });
    mocks.voice.mockResolvedValue({ success: true, settled: 0, scrubbed: 0, waiting: 0, failed: 0 });
    mocks.researchPrices.mockResolvedValue({ success: true, refreshed: [], changed: [], failed: [], expiring: [], window: 'skipped' });
    mocks.startRun.mockResolvedValue('run-1');
    mocks.finishRun.mockResolvedValue(undefined);
  });

  it('records every run in scheduled_job_runs: a success with counts, a failure with its reasons', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.startRun).toHaveBeenCalledWith({ supabase: { client: 'service-role' }, jobKey: 'billing_reconcile', triggerSource: 'cron' });
    expect(mocks.finishRun).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-1', status: 'success',
      summary: expect.objectContaining({ success: true, researchPrices: expect.objectContaining({ success: true }) }), error: undefined }));
    mocks.voice.mockResolvedValue({ success: false, settled: 0, scrubbed: 0, waiting: 0, failed: 2 });
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
    expect(mocks.finishRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error',
      error: expect.stringContaining('Voice generations pending recovery: 2') }));
  });

  it('does not depend on the run record: a failing record write leaves the job result alone', async () => {
    mocks.startRun.mockRejectedValue(new Error('db down'));
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.finishRun).not.toHaveBeenCalled();
  });

  it('lists the readiness warnings in the success log and the run summary without failing the job', async () => {
    mocks.runBillingEngineV15ReadinessAudit.mockResolvedValue({ ...readinessSuccess, summary: { unresolvedReservations: { count: 1, oldestAgeHours: 2, accounts: 1, credits: 113 } },
      findings: [{ code: 'billing_reservation_unresolved', severity: 'warning', message: 'Billing reservations have no observed terminal record (count=1)' }] });
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'completed', expect.any(Number), undefined,
      expect.objectContaining({ readinessAudit: expect.objectContaining({ warnings: [expect.stringContaining('count=1')] }) }));
    expect(mocks.finishRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success',
      summary: expect.objectContaining({ readiness: expect.objectContaining({ warnings: 1, errors: 0, unresolvedReservations: expect.objectContaining({ count: 1 }) }) }) }));
  });

  it('gives up on a price refresh that never answers and still completes the run', async () => {
    vi.useFakeTimers();
    try {
      mocks.researchPrices.mockReturnValue(new Promise(() => {}));
      const pending = GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
      await vi.advanceTimersByTimeAsync(46_000);
      const response = await pending;
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ researchPrices: { success: false, failed: [{ code: 'TIMEOUT' }] } });
      expect(mocks.finishRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
    } finally { vi.useRealTimers(); }
  });

  it('gives up on a billing scan that never answers, so the price refresh and the run record still complete', async () => {
    vi.useFakeTimers();
    try {
      mocks.runBillingEngineV15ReadinessAudit.mockReturnValue(new Promise(() => {}));
      const pending = GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
      await vi.advanceTimersByTimeAsync(41_000);
      const response = await pending;
      expect(response.status).toBe(500);
      expect(mocks.researchPrices).toHaveBeenCalledTimes(1);
      expect(await response.json()).toMatchObject({ researchPrices: { success: true }, readinessAudit: { success: false } });
      expect(mocks.finishRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error',
        summary: expect.objectContaining({ researchPrices: expect.objectContaining({ success: true }) }),
        error: expect.stringContaining('Billing readiness audit timed out') }));
    } finally { vi.useRealTimers(); }
  });

  it('refreshes research prices daily and fails the job while a price cannot be refreshed or is about to expire', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    // Outside the bound staging deployment there is no test window to follow the prices.
    expect(mocks.researchPrices).toHaveBeenCalledWith({ client: 'service-role' }, expect.objectContaining({ windowId: null }));
    mocks.researchPrices.mockResolvedValue({ success: false, refreshed: [], changed: [], failed: [{ route: '/x', code: 'HTTP_503' }],
      expiring: [{ provider: 'parallel', route: 'parallel:search:fast', validUntil: '2026-10-24T00:00:00.000Z' }], window: 'skipped' });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'failed', expect.any(Number),
      expect.stringContaining('Research prices: 1 refresh failures, 1 expiring within a day'), expect.anything());
    mocks.researchPrices.mockRejectedValue(new Error('unexpected'));
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
  });

  // CORE-PATH-V2 V2-12 B10: the old BILL2 scans are gone from the daily job.
  it('no longer runs the stale charged rounds, stuck PAYG calls or receipt retention segments', async () => {
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const key of ['staleRounds', 'stuckCalls', 'receiptRetention']) expect(body).not.toHaveProperty(key);
  });

  it('runs the voice recovery step and fails the job while a generation cannot be settled', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.voice).toHaveBeenCalledWith({ client: 'service-role' });
    mocks.voice.mockResolvedValue({ success: false, settled: 0, scrubbed: 0, waiting: 0, failed: 1 });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ voice: { failed: 1 } });
    mocks.voice.mockRejectedValue(new Error('unexpected'));
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
  });

  it('kicks stalled reviews from this deployment, and fails the job when the kick fails', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.fusionKick).toHaveBeenCalledWith({ client: 'service-role' }, 'https://graylum.test', { timeLimitMs: 10_000 });
    mocks.fusionKick.mockResolvedValue({ success: false, kicked: 0 });
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
    mocks.fusionKick.mockRejectedValue(new Error('unexpected'));
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(await response.json()).toMatchObject({ fusionKick: { success: false } });
  });

  it('no longer settles report prices: a report turn settles in turn_close, so the reconciliation has no report fee step (round 12 sweep)', async () => {
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('reportFees');
    const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/report_fee|settleDueReportFees|reportFees/);
  });

  it('rejects unauthorized invocation before creating a privileged client', async () => {
    mocks.validateCronRequest.mockReturnValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));

    expect(response.status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.runDailyBillingReconciliation).not.toHaveBeenCalled();
  });

  it('does not expose targetDate and always delegates the fixed window to the service', async () => {
    const response = await GET(new Request(
      'https://graylum.test/api/cron/billing-reconcile?targetDate=1999-01-01',
    ));

    expect(response.status).toBe(200);
    expect(mocks.runDailyBillingReconciliation).toHaveBeenCalledWith({ client: 'service-role' });
    expect(mocks.runDailyBillingReconciliation.mock.calls[0]).toHaveLength(1);
  });

  it('returns 500 and emits the existing cron failure signal on a mismatch', async () => {
    mocks.runDailyBillingReconciliation.mockResolvedValue({
      ...dailySuccess,
      success: false,
      status: 'FAILED',
      mismatches: ['paid order was not fulfilled'],
    });

    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      mismatches: ['paid order was not fulfilled'],
    });
    expect(mocks.cronJob).toHaveBeenCalledWith(
      'billing-reconcile',
      'failed',
      expect.any(Number),
      expect.stringContaining('paid order was not fulfilled'),
      expect.any(Object),
    );
  });

  it('returns 500 and preserves service BLOCKED details when launch_baseline_at is unavailable', async () => {
    mocks.runDailyBillingReconciliation.mockResolvedValue({
      ...dailySuccess,
      success: false,
      status: 'BLOCKED',
      launchBaselineAt: null,
      mismatches: ['BLOCKED: launch_baseline_at is missing'],
    });
    mocks.runBillingEngineV15ReadinessAudit.mockResolvedValue({
      ...readinessSuccess,
      success: false,
      status: 'BLOCKED',
      launchBaselineAt: null,
      findings: [{ code: 'launch_baseline_missing', message: 'BLOCKED' }],
    });

    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      mismatches: ['BLOCKED: launch_baseline_at is missing'],
      readinessAudit: {
        status: 'BLOCKED',
        launchBaselineAt: null,
      },
    });
    expect(mocks.cronJob).toHaveBeenCalledWith(
      'billing-reconcile',
      'failed',
      expect.any(Number),
      expect.stringContaining('BLOCKED'),
      expect.any(Object),
    );
  });

  it('runs Waffo cash recovery and original-order refunds only in the bound environment', async () => {
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'false');
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.waffo).not.toHaveBeenCalled();
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'true');
    const binding = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
      VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic-project',
      V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic-project', V3_RUNTIME_STAGING_DATABASE_HOST: 'example.supabase.co',
      V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001' };
    for (const [key, value] of Object.entries(binding)) vi.stubEnv(key, value);
    mocks.waffoClient.mockReturnValue({ merchant: 'fixture' });
    mocks.closeExpired.mockResolvedValue(2);
    mocks.waffo.mockResolvedValue({ success: false, complete: true, checkedPayments: 1,
      findings: [{ kind: 'paid_not_delivered', paymentId: 'PAY_1', refundCandidate: false }] });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ waffo: { closedExpired: 2, findings: [{ kind: 'paid_not_delivered' }] } });
    expect(mocks.closeExpired).toHaveBeenCalledWith({ client: 'service-role' }, 'fixture', undefined, 'test');
    // Waffo chargebacks alert through the same once-per-dispute channel as Stripe disputes.
    expect(mocks.waffo).toHaveBeenCalledWith({ client: 'service-role' }, { merchant: 'fixture' },
      expect.objectContaining({ recover: true, disputeAlert: expect.any(Function) }));
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'failed', expect.any(Number),
      expect.stringContaining('Waffo payments need manual review: 1'), expect.any(Object));
    mocks.waffo.mockRejectedValue(new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE'));
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: false, waffo: { findings: [{ kind: 'scan_failed' }] } });
    expect(mocks.logError).toHaveBeenCalledWith('billing', 'pay_waffo_reconciliation_failed',
      { code: 'PAY_WAFFO_PROVIDER_UNAVAILABLE', errorName: 'Error' });
    vi.unstubAllEnvs();
  });

  it('runs the Stripe card backstop, alerts on findings, and never blocks the other audits', async () => {
    const finding = { kind: 'paid_not_delivered', object: 'checkout', externalId: 'cs_1', orderId: 'o-1' };
    mocks.stripeCard.mockResolvedValue({ success: false, skipped: false, complete: true, repaired: 1, checked: 3, findings: [finding] });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ stripeCard: { repaired: 1, findings: [finding] }, summary: {} });
    expect(mocks.stripeCard).toHaveBeenCalledWith({ client: 'service-role' }, { client: 'stripe' },
      { expectedMode: 'test', alert: expect.any(Function), disputeAlert: expect.any(Function) });
    expect(mocks.reportStripeCard).toHaveBeenCalledWith([finding]);
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'failed', expect.any(Number),
      expect.stringContaining('Stripe card payments need manual review: 1'), expect.objectContaining({ stripeCard: expect.any(Object) }));
    // A key of the other mode (e.g. live keys on staging) is refused and alerted.
    mocks.stripeCard.mockRejectedValue(new Error('PAY_STRIPE_MP_RECONCILIATION_MODE_MISMATCH'));
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: false, stripeCard: { findings: [{ kind: 'scan_failed', code: 'PAY_STRIPE_MP_RECONCILIATION_MODE_MISMATCH' }] } });
    expect(mocks.reportStripeCard).toHaveBeenLastCalledWith([{ kind: 'scan_failed', code: 'PAY_STRIPE_MP_RECONCILIATION_MODE_MISMATCH' }]);
    // Enabled but Stripe is not configured: a failure, not a silent skip.
    mocks.stripeClient.mockImplementation(() => { throw new Error('STRIPE_SECRET_KEY missing'); });
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: false, stripeCard: { findings: [{ kind: 'scan_failed', code: 'STRIPE_NOT_CONFIGURED' }] } });
    // A typo is a configuration failure, not the intentional "off".
    vi.stubEnv('STRIPE_CARD_RECONCILIATION_MODE', 'TEST');
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: false, stripeCard: { findings: [{ kind: 'scan_failed', code: 'STRIPE_CARD_RECONCILIATION_MODE_INVALID' }] } });
    // Not enabled for this environment (the production default until the Owner approves): skipped.
    vi.stubEnv('STRIPE_CARD_RECONCILIATION_MODE', '');
    mocks.stripeCard.mockClear();
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: true, stripeCard: { skipped: true } });
    expect(mocks.stripeCard).not.toHaveBeenCalled();
  });

  it('stops waiting for a stalled Stripe scan before the cron limit and reports it', async () => {
    vi.useFakeTimers();
    try {
      mocks.stripeCard.mockReturnValue(new Promise(() => {}));
      const pending = GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
      await vi.advanceTimersByTimeAsync(50_000);
      expect(await (await pending).json()).toMatchObject({ success: false,
        stripeCard: { findings: [{ kind: 'scan_failed', code: 'STRIPE_CARD_RECONCILIATION_TIMEOUT' }] } });
    } finally { vi.useRealTimers(); }
  });

  it('registers one daily UTC reconciliation cron', () => {
    const config = JSON.parse(readFileSync(
      new URL('../../../../../vercel.json', import.meta.url),
      'utf8',
    ));

    expect(config.crons.filter((cron: { path: string }) => (
      cron.path === '/api/cron/billing-reconcile'
    ))).toEqual([{
      path: '/api/cron/billing-reconcile',
      schedule: '0 4 * * *',
    }]);
  });
});

it('reports an unresolved erasure batch as failure while preserving both original audits', async () => {
  mocks.erasure.mockResolvedValue({ success: false, pending: 1, failed: 0, oldestPendingAt: '2026-01-01T00:00:00Z' });
  const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ success: false, erasureFinancial: { pending: 1 } });
  expect(mocks.runDailyBillingReconciliation).toHaveBeenCalled();
  expect(mocks.runBillingEngineV15ReadinessAudit).toHaveBeenCalled();
});
