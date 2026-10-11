/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWaffoTestOperationsClient, getWaffoTestOperationsClient } from './waffoTestOperationsClient';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { merchant: 'fixture', merchantId: 'MER_fixture', storeId: 'STO_fixture',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
afterEach(() => vi.unstubAllEnvs());
describe('Pancake test operation transport', () => {
  it('signs the exact method/path/time/body, disables redirects and automatic retries', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { orderId: 'ORD_original', status: 'canceling' } }));
    const client = createWaffoTestOperationsClient(config, request);
    expect(await client.cancelSubscription('ORD_original')).toEqual({ orderId: 'ORD_original', status: 'canceling' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.waffo.ai/v1/actions/subscription-order/cancel-order');
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    const digest = createHash('sha256').update(init.body).digest('base64');
    const canonical = `POST\n/v1/actions/subscription-order/cancel-order\n${init.headers['X-Timestamp']}\n${digest}`;
    expect(createVerify('RSA-SHA256').update(canonical).verify(keys.publicKey, init.headers['X-Signature'], 'base64')).toBe(true);
    request.mockRejectedValue(new Error('timeout'));
    await expect(client.cancelSubscription('ORD_original')).rejects.toThrow('timeout');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('checks product store ownership and fails closed on GraphQL partial errors', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { store: { id: 'STO_wrong', subscriptionProducts: [] } } }));
    const client = createWaffoTestOperationsClient(config, request);
    await expect(client.readProduct('PROD_1')).rejects.toThrow('OPERATION_SCOPE');
    request.mockResolvedValue(Response.json({ data: { subscriptionOrders: [] }, errors: [{ message: 'scope error' }] }));
    await expect(client.readSubscription('ORD_original')).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
  it('does not load a provider binding until explicitly enabled in test configuration', () => {
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'false');
    expect(getWaffoTestOperationsClient).toThrow('TEST_CONFIG_UNAVAILABLE');
  });
});
