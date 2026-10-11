/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWaffoTestOperationsClient, getWaffoTestOperationsClient } from './waffoTestOperationsClient';
import { payment } from './waffoTestHarness';
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
    request.mockRejectedValue(new DOMException('aborted', 'TimeoutError'));
    await expect(client.cancelSubscription('ORD_original')).rejects.toMatchObject({ message: 'PAY_WAFFO_PROVIDER_UNAVAILABLE',
      detail: { category: 'timeout', path: '/v1/actions/subscription-order/cancel-order' } });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('checks product store ownership and fails closed on GraphQL partial errors', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { store: { id: 'STO_wrong', subscriptionProducts: [] } } }));
    const client = createWaffoTestOperationsClient(config, request);
    await expect(client.readProduct('PROD_1')).rejects.toThrow('OPERATION_SCOPE');
    request.mockResolvedValue(Response.json({ data: { store: { id: 'STO_fixture' },
      subscriptionProducts: [{ id: 'PROD_1', status: 'active' }, { id: 'PROD_1', status: 'inactive' }] } }));
    await expect(client.readProduct('PROD_1')).rejects.toThrow('OPERATION_SCOPE');
    request.mockResolvedValue(Response.json({ data: { subscriptionOrders: [] }, errors: [{ message: 'scope error' }] }));
    await expect(client.readSubscription('ORD_original')).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
  it('reads one product with the measured String-typed, store-scoped query (no ID scalar)', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { store: { id: 'STO_fixture' },
      subscriptionProducts: [{ id: 'PROD_1', status: 'inactive' }] } }));
    expect(await createWaffoTestOperationsClient(config, request).readProduct('PROD_1')).toEqual({ id: 'PROD_1', status: 'inactive' });
    const sent = JSON.parse(request.mock.calls[0]![1].body);
    expect(sent.query).not.toMatch(/\bID!/);
    expect(sent.query).toMatch(/\$storeId: String!/);
    expect(sent.query).toMatch(/subscriptionProducts\(storeId: \$storeId, filter: \{ id: \{ in: \[\$id\] \} \}/);
    expect(sent.variables).toEqual({ storeId: 'STO_fixture', id: 'PROD_1' });
  });
  it('reads payments with measured fields and creates checkout with a fixed idempotency key', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { payment: payment() } }));
    const client = createWaffoTestOperationsClient(config, request);
    expect((await client.readPayment('PAY_fixture1'))?.id).toBe('PAY_fixture1');
    expect(JSON.parse(request.mock.calls[0]![1].body).query).toMatch(/payment\(id: \$id\)/);
    request.mockResolvedValue(Response.json({ data: { payment: payment({ id: 'PAY_other' }) } }));
    await expect(client.readPayment('PAY_fixture1')).rejects.toThrow('OPERATION_SCOPE');
    request.mockResolvedValue(Response.json({ data: { payments: [payment()] } }));
    expect(await client.listPayments(100)).toMatchObject({ complete: true, rows: [{ id: 'PAY_fixture1' }] });
    expect(JSON.parse(request.mock.calls.at(-1)![1].body).query).toMatch(/limit: 100, offset: 100/);
    await expect(client.listPayments(-1)).rejects.toThrow('OPERATION_SCOPE');
    request.mockResolvedValue(Response.json({ data: { sessionId: 'cs_x' } }));
    await client.createCheckout({ productId: 'PROD_1' }, 'graylum-checkout-fixture');
    const [url, init] = request.mock.calls.at(-1)!;
    expect(url).toBe('https://api.waffo.ai/v1/actions/checkout/create-session');
    expect(init.headers['X-Idempotency-Key']).toBe('graylum-checkout-fixture');
    await expect(client.createCheckout({}, 'x')).rejects.toThrow('CHECKOUT_INVALID');
    request.mockResolvedValue(new Response('{}', { status: 400 }));
    await expect(client.createCheckout({}, 'graylum-checkout-fixture')).rejects.toThrow('PROVIDER_REJECTED');
    for (const status of [409, 429, 503]) {
      request.mockResolvedValue(new Response('{}', { status }));
      await expect(client.createCheckout({}, 'graylum-checkout-fixture')).rejects.toThrow('PROVIDER_UNAVAILABLE');
    }
  });
  it('signs with a key pasted as one line with literal \\n, and rejects an unusable key before any request', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { orderId: 'ORD_original', status: 'canceling' } }));
    await createWaffoTestOperationsClient({ ...config, privateKey: config.privateKey.replace(/\n/g, '\\n') }, request)
      .cancelSubscription('ORD_original');
    const [, init] = request.mock.calls[0]!;
    const digest = createHash('sha256').update(init.body).digest('base64');
    const canonical = `POST\n/v1/actions/subscription-order/cancel-order\n${init.headers['X-Timestamp']}\n${digest}`;
    expect(createVerify('RSA-SHA256').update(canonical).verify(keys.publicKey, init.headers['X-Signature'], 'base64')).toBe(true);
    request.mockClear();
    expect(() => createWaffoTestOperationsClient({ ...config, privateKey: 'pasted-wrong-value' }, request))
      .toThrow('PAY_WAFFO_TEST_CONFIG_INVALID');
    expect(request).not.toHaveBeenCalled();
  });
  it('classifies provider failures for logs while keeping the control-flow codes', async () => {
    const request = vi.fn();
    const client = createWaffoTestOperationsClient(config, request);
    const cases: [Response | Error, string, Record<string, unknown>][] = [
      [Response.json({ data: null, errors: [{ message: 'Invalid signature', layer: 'gateway' }] }, { status: 401 }),
        'PAY_WAFFO_PROVIDER_REJECTED', { category: 'http_status', httpStatus: 401,
          providerErrors: [{ layer: 'gateway', message: 'Invalid signature' }] }],
      [new Response('<html>', { status: 502 }), 'PAY_WAFFO_PROVIDER_UNAVAILABLE', { category: 'http_status', httpStatus: 502 }],
      [new Response('<html>', { status: 200 }), 'PAY_WAFFO_PROVIDER_UNAVAILABLE', { category: 'non_json', httpStatus: 200 }],
      [Response.json({ data: null, errors: [{ message: 'x'.repeat(500), layer: 'checkout' }] }), 'PAY_WAFFO_PROVIDER_UNAVAILABLE',
        { category: 'provider_errors', providerErrors: [{ layer: 'checkout', message: 'x'.repeat(200) }] }],
      [Response.json({ data: null }), 'PAY_WAFFO_PROVIDER_UNAVAILABLE', { category: 'empty_data' }],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'PAY_WAFFO_PROVIDER_UNAVAILABLE',
        { category: 'network', errorCode: 'ENOTFOUND' }],
    ];
    for (const [outcome, message, detail] of cases) {
      if (outcome instanceof Response) request.mockResolvedValueOnce(outcome); else request.mockRejectedValueOnce(outcome);
      await expect(client.createCheckout({}, 'graylum-checkout-fixture')).rejects.toMatchObject({ message,
        detail: { path: '/v1/actions/checkout/create-session', ...detail } });
    }
  });
  it('gives checkout creation a longer timeout than reads', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const request = vi.fn().mockResolvedValue(Response.json({ data: { sessionId: 'cs_x' } }));
    const client = createWaffoTestOperationsClient(config, request);
    await client.createCheckout({}, 'graylum-checkout-fixture');
    request.mockResolvedValue(Response.json({ data: { orderId: 'ORD_original', status: 'canceling' } }));
    await client.cancelSubscription('ORD_original');
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([20000, 8000]);
    timeout.mockRestore();
  });
  it('does not load a provider binding until explicitly enabled in test configuration', () => {
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'false');
    expect(getWaffoTestOperationsClient).toThrow('TEST_CONFIG_UNAVAILABLE');
  });
});
