import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  runDailyBillingReconciliation: vi.fn(),
  runBillingEngineV15ReadinessAudit: vi.fn(),
  validateCronRequest: vi.fn(),
  cronJob: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@repo/api/src/services/billingReconciliation', () => ({
  runDailyBillingReconciliation: mocks.runDailyBillingReconciliation,
  runBillingEngineV15ReadinessAudit: mocks.runBillingEngineV15ReadinessAudit,
}));

vi.mock('@repo/api/src/services', () => ({
  logger: {
    system: {
      cronJob: mocks.cronJob,
    },
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
    mocks.createClient.mockReturnValue({ client: 'service-role' });
    mocks.runDailyBillingReconciliation.mockResolvedValue(dailySuccess);
    mocks.runBillingEngineV15ReadinessAudit.mockResolvedValue(readinessSuccess);
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
