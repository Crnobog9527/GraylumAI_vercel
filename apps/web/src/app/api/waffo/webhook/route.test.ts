/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ http: vi.fn(async () => new Response(null, { status: 503 })), notify: vi.fn(async () => {}) }));
vi.mock('@repo/api/src/services/payments/waffoWebhookHttp', () => ({ handleWaffoWebhookHttp: m.http }));
vi.mock('@repo/api/src/services/ownerAlerts', () => ({ notifyOwner: m.notify }));
vi.mock('@repo/api/src/services/stripe', () => ({ createServiceRoleSupabaseClient: vi.fn() }));
vi.mock('@repo/api/src/services/payments/waffoPaymentDelivery', () => ({ processWaffoReceipt: vi.fn() }));
vi.mock('@repo/api/src/services/payments/waffoTestOperationsClient', () => ({ getWaffoOperationsClient: vi.fn() }));
vi.mock('@repo/api/src/services/payments/methodCheckoutGate', () => ({ paymentDeploymentMode: vi.fn(), assertWaffoWebhookEnvironment: vi.fn() }));
vi.mock('@repo/api/src/services/payments/failoverAfterFulfillment', () => ({ afterWaffoFulfillment: vi.fn() }));
import { POST } from './route';

it('ALERT-FEISHU: maps a failed Waffo delivery to the Owner alert by receipt, and a storage failure to the hourly one', async () => {
  await POST(new Request('https://synthetic.test/api/waffo/webhook', { method: 'POST', body: '{}' }));
  const deps = (m.http.mock.calls[0] as unknown as [Request, { onFailure: (f: unknown) => Promise<void> }])[1];
  await deps.onFailure({ stage: 'processing', receiptId: 'receipt-1' });
  expect(m.notify).toHaveBeenLastCalledWith('payment_webhook_failed',
    { provider: 'waffo', eventId: 'receipt-1', eventType: null, code: 'WAFFO_PROCESSING_DEFERRED' });
  await deps.onFailure({ stage: 'storage' });
  expect(m.notify).toHaveBeenLastCalledWith('payment_webhook_unavailable', { provider: 'waffo', reason: 'storage' });
});
