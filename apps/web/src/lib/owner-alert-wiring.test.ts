/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ captureMessage: vi.fn(), flush: vi.fn(), alert: vi.fn(), after: vi.fn(), notify: vi.fn(async () => {}),
  note: vi.fn(async () => {}) }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, flush: m.flush }));
vi.mock('next/server', () => ({ after: m.after }));
vi.mock('@repo/api/src/services/ownerAlerts', () => ({ notifyOwner: m.notify }));
vi.mock('@repo/api/src/services/ownerAlerts/errorSpike', () => ({ noteServerError: m.note }));

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

describe('alertOwnerAfterResponse', () => {
  it('schedules the Feishu send after the response, and sends at once outside a request', async () => {
    const { alertOwnerAfterResponse } = await import('./owner-alert');
    alertOwnerAfterResponse('provider_402', { provider: 'openrouter' });
    expect(m.notify).not.toHaveBeenCalled();
    await (m.after.mock.calls[0]![0] as () => Promise<void>)();
    expect(m.notify).toHaveBeenCalledExactlyOnceWith('provider_402', { provider: 'openrouter' });
    m.after.mockImplementationOnce(() => { throw new Error('`after` was called outside a request scope'); });
    alertOwnerAfterResponse('test', { note: 'x' });
    expect(m.notify).toHaveBeenLastCalledWith('test', { note: 'x' });
  });
});

describe('every Sentry alert helper the Owner relied on also goes to Feishu', () => {
  beforeEach(() => { vi.doMock('@/lib/owner-alert', () => ({ alertOwnerAfterResponse: m.alert })); vi.resetModules(); });

  it('disputes, with the same code, internal id and evidence date', async () => {
    const { reportPaymentDispute } = await import('./payment-dispute-alert.mjs');
    reportPaymentDispute({ code: 'PAY_DISPUTE_OPENED', disputeId: 'd-1', dueBy: '2026-11-20T00:00:00Z' });
    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    expect(m.alert).toHaveBeenCalledExactlyOnceWith('dispute', { code: 'PAY_DISPUTE_OPENED', disputeId: 'd-1', dueBy: '2026-11-20T00:00:00Z' });
  });

  it('billing checks, with their fixed code and count only', async () => {
    const pay = await import('./payment-alert.mjs');
    pay.reportStripeCardReconciliation([{ kind: 'scan_failed' }, { kind: 'scan_failed' }]);
    pay.reportAnnualReleaseAnomalies([{ subscriptionId: 's', reason: 'r' }]);
    pay.reportPaymentNoticeAttention([{ attention: 'PAY_NOTIFY_RETRIES_EXHAUSTED' }, { attention: null }]);
    pay.reportPaymentEvidenceConflict('invoice.paid');
    expect(m.alert.mock.calls).toEqual([
      ['billing_review', { code: 'PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED', count: 2 }],
      ['billing_review', { code: 'PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED', count: 1 }],
      ['billing_review', { code: 'PAY_NOTIFY_REVIEW_REQUIRED', count: 1 }],
      ['billing_review', { code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT', count: null }],
    ]);
    // Nothing found: neither Sentry nor Feishu.
    m.alert.mockClear();
    pay.reportStripeCardReconciliation([]);
    pay.reportPaymentNoticeAttention([{ attention: null }]);
    expect(m.alert).not.toHaveBeenCalled();
  });

  it('privacy and Post for Me backlogs, with code and level', async () => {
    const erasure = await import('./erasure-backlog-alert');
    erasure.reportErasureBacklog({ open: 2, overError: 1, overFatal: 0, oldestConfirmedAt: null });
    erasure.reportLibraryBacklog({ pending: 6000, overdue: 0, oldestDeletedAt: null });
    const publish = await import('./publish-monitor-alert');
    publish.reportPublishMonitorQuota({ configured: true, limit: 100, used: 80, reserved: 0 }, 'near');
    publish.reportPublishMonitorQuota({ configured: true, limit: 100, used: 100, reserved: 0 }, 'full');
    publish.reportPublishMonitorStuck({ connections: 1, requests: 0 });
    publish.reportPublishMonitorQuota({ configured: true }, 'ok');
    expect(m.alert.mock.calls).toEqual([
      ['ops_backlog', { code: 'ERASURE_BACKLOG', level: 'error' }],
      ['ops_backlog', { code: 'LIBRARY_CLEANUP_BACKLOG', level: 'fatal' }],
      ['ops_backlog', { code: 'PUBLISH_MONITOR_QUOTA_NEAR', level: 'warning' }],
      ['ops_backlog', { code: 'PUBLISH_MONITOR_QUOTA_FULL', level: 'fatal' }],
      ['ops_backlog', { code: 'PUBLISH_MONITOR_CLEANUP_STUCK', level: 'error' }],
    ]);
  });
});

describe('countServerError (Sentry beforeSend)', () => {
  it('counts error and fatal events, then still sends them; passes warnings and dropped events untouched', async () => {
    const { countServerError } = await import('./sentry-error-spike');
    const error = { level: 'error' } as never;
    await expect(countServerError(error)).resolves.toBe(error);
    await expect(countServerError({ level: 'fatal' } as never)).resolves.toEqual({ level: 'fatal' });
    await expect(countServerError({} as never)).resolves.toEqual({});
    expect(m.note).toHaveBeenCalledTimes(3);
    expect(countServerError({ level: 'warning' } as never)).toEqual({ level: 'warning' });
    expect(countServerError(null)).toBeNull();
    expect(m.note).toHaveBeenCalledTimes(3);
  });
});
