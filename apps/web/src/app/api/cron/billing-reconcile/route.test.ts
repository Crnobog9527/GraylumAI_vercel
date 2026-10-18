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
  waffoClient: vi.fn(),
  closeExpired: vi.fn(),
  logError: vi.fn(),
  staleRounds: vi.fn(),
  stripeCard: vi.fn(),
  stripeClient: vi.fn(),
  reportStripeCard: vi.fn(),
  fusion: vi.fn(),
  stuckCalls: vi.fn(),
  fusionKick: vi.fn(),
  reportFees: vi.fn(),
}));

vi.mock('@repo/api/src/services/payments/waffoReconciliation', () => ({ reconcileWaffoPayments: mocks.waffo }));
vi.mock('@repo/api/src/services/payments/waffoTestOperationsClient', () => ({ getWaffoTestOperationsClient: mocks.waffoClient }));
vi.mock('@repo/api/src/services/runtime/staleChargedRounds', () => ({ findStaleChargedRounds: mocks.staleRounds }));
vi.mock('@repo/api/src/services/payments/stripeCardReconciliation', () => ({ reconcileStripeCardPayments: mocks.stripeCard }));
vi.mock('@repo/api/src/services/stripe', () => ({ getStripeClient: mocks.stripeClient }));
vi.mock('@/lib/payment-alert.mjs', () => ({ reportStripeCardReconciliation: mocks.reportStripeCard,
  reportPaymentEvidenceConflict: vi.fn() }));
vi.mock('@repo/api/src/services/fusion/recovery', () => ({ recoverFusionFinancials: mocks.fusion }));
vi.mock('@repo/api/src/services/bill2/stuckCalls', () => ({ findStuckPaygCalls: mocks.stuckCalls }));
vi.mock('@repo/api/src/services/fusion/background', () => ({ kickStalledReviews: mocks.fusionKick }));
vi.mock('@repo/api/src/services/report/fees', () => ({ settleDueReportFees: mocks.reportFees }));
vi.mock('@repo/api/src/services/payments/waffoCardCheckout', () => ({ closeExpiredWaffoCheckouts: mocks.closeExpired }));

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
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    mocks.validateCronRequest.mockReturnValue(null);
    mocks.erasure.mockResolvedValue({ success: true, pending: 0, failed: 0 });
    mocks.createClient.mockReturnValue({ client: 'service-role' });
    mocks.runDailyBillingReconciliation.mockResolvedValue(dailySuccess);
    mocks.runBillingEngineV15ReadinessAudit.mockResolvedValue(readinessSuccess);
    mocks.staleRounds.mockResolvedValue({ success: true, findings: [], total: 0, truncated: false });
    vi.stubEnv('STRIPE_CARD_RECONCILIATION_MODE', 'test');
    mocks.stripeClient.mockReturnValue({ client: 'stripe' });
    mocks.stripeCard.mockResolvedValue({ success: true, skipped: true, findings: [] });
    mocks.fusion.mockResolvedValue({ success: true, scanned: 0, cancelled: 0, recovered: 0, scrubbed: 0, failed: 0 });
    mocks.fusionKick.mockResolvedValue({ success: true, kicked: 0, listed: 0 });
    mocks.reportFees.mockResolvedValue({ success: true, settled: 0 });
    mocks.stuckCalls.mockResolvedValue({ success: true, calls: [], total: 0, truncated: false });
  });

  // 0261: a PAYG call whose cost never became known keeps the daily job failing (the alert) until settled.
  it('fails the daily job every run while a PAYG call with unknown cost awaits manual settlement', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.stuckCalls).toHaveBeenCalledWith({ client: 'service-role' });
    mocks.stuckCalls.mockResolvedValue({ success: false, calls: [], total: 3, truncated: true });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ stuckCalls: { total: 3 } });
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'failed', expect.any(Number),
      expect.stringContaining('PAYG calls with unknown cost need manual settlement: 3'), expect.anything());
    mocks.stuckCalls.mockRejectedValue(new Error('unexpected'));
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
  });

  it('runs the Fusion recovery step and fails the job while a Fusion call stays pending', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.fusion).toHaveBeenCalledWith({ client: 'service-role' });
    mocks.fusion.mockResolvedValue({ success: false, scanned: 1, cancelled: 0, recovered: 0, scrubbed: 0, failed: 1 });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ fusion: { failed: 1 } });
    mocks.fusion.mockRejectedValue(new Error('unexpected'));
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
  });

  it('kicks stalled reviews before the Fusion recovery, from this deployment, and fails the job when the kick fails', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.fusionKick.mock.invocationCallOrder[0]).toBeLessThan(mocks.fusion.mock.invocationCallOrder[0]!);
    expect(mocks.fusionKick).toHaveBeenCalledWith({ client: 'service-role' }, 'https://graylum.test', { timeLimitMs: 10_000 });
    mocks.fusionKick.mockResolvedValue({ success: false, kicked: 0 });
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
    mocks.fusionKick.mockRejectedValue(new Error('unexpected'));
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(await response.json()).toMatchObject({ fusionKick: { success: false } });
  });

  it('settles held report prices (0295) and fails the job when that step fails', async () => {
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.reportFees).toHaveBeenCalledWith({ client: 'service-role' });
    mocks.reportFees.mockResolvedValue({ success: false, settled: 0 });
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(500);
    mocks.reportFees.mockRejectedValue(new Error('unexpected'));
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(await response.json()).toMatchObject({ reportFees: { success: false } });
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

  it('runs the report-only Waffo reconciliation only when the test binding is enabled', async () => {
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'false');
    expect((await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).status).toBe(200);
    expect(mocks.waffo).not.toHaveBeenCalled();
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'true');
    mocks.waffoClient.mockReturnValue({ merchant: 'fixture' });
    mocks.closeExpired.mockResolvedValue(2);
    mocks.waffo.mockResolvedValue({ success: false, complete: true, checkedPayments: 1,
      findings: [{ kind: 'paid_not_delivered', paymentId: 'PAY_1', refundCandidate: false }] });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ waffo: { closedExpired: 2, findings: [{ kind: 'paid_not_delivered' }] } });
    expect(mocks.closeExpired).toHaveBeenCalledWith({ client: 'service-role' }, 'fixture');
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'failed', expect.any(Number),
      expect.stringContaining('Waffo payments need manual review: 1'), expect.any(Object));
    mocks.waffo.mockRejectedValue(new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE'));
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: false, waffo: { findings: [{ kind: 'scan_failed' }] } });
    expect(mocks.logError).toHaveBeenCalledWith('billing', 'pay_waffo_reconciliation_failed',
      { code: 'PAY_WAFFO_PROVIDER_UNAVAILABLE', errorName: 'Error' });
    vi.unstubAllEnvs();
  });

  it('reports stale charged rounds for manual review without failing the other audits', async () => {
    const finding = { kind: 'stale_charged_round', executionId: 'e-1', runId: 'r-1', chargedCredits: 1,
      since: '2026-10-11T18:02:00.000Z' };
    mocks.staleRounds.mockResolvedValue({ success: false, findings: [finding], total: 1, truncated: false });
    const response = await GET(new Request('https://graylum.test/api/cron/billing-reconcile'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ staleRounds: { findings: [finding] }, summary: {} });
    expect(mocks.staleRounds).toHaveBeenCalledWith({ client: 'service-role' });
    expect(mocks.cronJob).toHaveBeenCalledWith('billing-reconcile', 'failed', expect.any(Number),
      expect.stringContaining('Stale charged rounds need manual review: 1'), expect.objectContaining({ staleRounds: expect.any(Object) }));
    mocks.staleRounds.mockRejectedValue(new Error('STALE_ROUND_SCAN_FAILED'));
    expect(await (await GET(new Request('https://graylum.test/api/cron/billing-reconcile'))).json())
      .toMatchObject({ success: false, staleRounds: { scanFailed: true } });
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
