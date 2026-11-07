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
  it('runs normal-path delivery only after a durable receipt and asks for redelivery when it fails', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'receipt-1', error: null });
    const process = vi.fn().mockResolvedValue({ state: 'applied' });
    const deps = { config: () => config, database: () => ({ rpc }), process };
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(200);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ receiptId: 'receipt-1', merchant: 'fixture',
      refs: { orderId: 'order-1', paymentId: 'payment-1' } }));
    process.mockRejectedValue(new Error('PAY_WAFFO_PAYMENT_NOT_VISIBLE'));
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(503);
    rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    process.mockClear();
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(503);
    expect(process).not.toHaveBeenCalled();
  });
  it('ALERT-FEISHU: reports a failed delivery by receipt and a storage failure, and a throwing hook never changes the answer', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'receipt-1', error: null });
    const onFailure = vi.fn(async () => {});
    const process = vi.fn().mockRejectedValue(new Error('PAY_WAFFO_PAYMENT_NOT_VISIBLE'));
    const deps = { config: () => config, database: () => ({ rpc }), process, onFailure };
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(503);
    expect(onFailure).toHaveBeenLastCalledWith({ stage: 'processing', receiptId: 'receipt-1' });
    rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(503);
    expect(onFailure).toHaveBeenLastCalledWith({ stage: 'storage' });
    rpc.mockResolvedValue({ data: 'receipt-1', error: null });
    process.mockResolvedValue({ state: 'applied' });
    onFailure.mockClear();
    expect((await handleWaffoWebhookHttp(request(), deps)).status).toBe(200);
    expect(onFailure).not.toHaveBeenCalled();
    const throwing = { ...deps, process: vi.fn().mockRejectedValue(new Error('x')), onFailure: () => { throw new Error('hook'); } };
    expect((await handleWaffoWebhookHttp(request(), throwing as never)).status).toBe(503);
    // An invalid signature is the sender's problem, not ours: no alert.
    const bad = new Request('https://test.invalid/api/waffo/webhook', { method: 'POST', body: '{}', headers: { 'x-waffo-signature': 't=1,v1=x' } });
    expect((await handleWaffoWebhookHttp(bad, deps)).status).toBe(400);
    expect(onFailure).not.toHaveBeenCalled();
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
