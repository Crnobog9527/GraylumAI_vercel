/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { handleWaffoWebhookHttp } from './waffoWebhookHttp';
import { WAFFO_MAX_BODY_BYTES } from './waffoWebhook';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  storeId: 'store-test', merchantNamespace: 'fixture' };
function request(body = JSON.stringify({ eventType: 'subscription.payment_succeeded', eventId: 'event.1',
  storeId: 'store-test', mode: 'test', data: { orderId: 'order-1', paymentId: 'payment-1' } })) {
  const timestamp = Date.now().toString();
  const signature = createSign('RSA-SHA256').update(`${timestamp}.${body}`).sign(keys.privateKey, 'base64');
  return new Request('https://test.invalid/api/waffo/webhook', { method: 'POST', body,
    headers: { 'x-waffo-signature': `t=${timestamp},v1=${signature}` } });
}
describe('Waffo HTTP boundary', () => {
  it('acknowledges only durable receipts, retries persistence failures', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'receipt-1', error: null });
    const deps = { config: () => config, database: () => ({ rpc }) };
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(200);
    rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(503);
  });
  it('fails closed without configuration; never invokes persistence for invalid or large bodies', async () => {
    const database = vi.fn();
    expect((await handleWaffoWebhookHttp(request(), { config: () => null, database })).status).toBe(503);
    const unsigned = new Request('https://test.invalid', { method: 'POST', body: '{}' });
    expect((await handleWaffoWebhookHttp(unsigned, { config: () => config, database })).status).toBe(400);
    expect((await handleWaffoWebhookHttp(request('x'.repeat(WAFFO_MAX_BODY_BYTES + 1)),
      { config: () => config, database })).status).toBe(413);
    expect(database).not.toHaveBeenCalled();
  });
});
