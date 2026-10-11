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
}));

vi.mock('@repo/api/src/services/payments/waffoReconciliation', () => ({ reconcileWaffoPayments: mocks.waffo }));
vi.mock('@repo/api/src/services/payments/waffoTestOperationsClient', () => ({ getWaffoTestOperationsClient: mocks.waffoClient }));
vi.mock('@repo/api/src/services/runtime/staleChargedRounds', () => ({ findStaleChargedRounds: mocks.staleRounds }));
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
      since: '2026-10-11T18:02:00.000Z', refundMarker: 'stale-round:r-1' };
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
