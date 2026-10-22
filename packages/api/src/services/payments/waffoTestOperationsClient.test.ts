/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWaffoTestOperationsClient, createWaffoOperationsClient, getWaffoTestOperationsClient } from './waffoTestOperationsClient';
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
  it('checks a one-time product in the bound store and supports an explicitly selected live client', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: { onetimeProducts: [{ id: 'PROD_once', storeId: 'STO_fixture', status: 'active', prices: [{ currency: 'USD', priceInfo: { amount: '69.00', taxCategory: 'saas' } }] }] } }));
    const client = createWaffoOperationsClient({ ...config, mode: 'live' }, request);
    expect(client.mode).toBe('live');
    expect(await client.readOneTimeProduct('PROD_once')).toEqual({ id: 'PROD_once', storeId: 'STO_fixture', status: 'active', prices: [{ currency: 'USD', priceInfo: { amount: '69.00', taxCategory: 'saas' } }] });
    const query = JSON.parse(request.mock.calls[0]![1].body);
    expect(query.query).toContain('onetimeProducts(storeId: $storeId');
    request.mockResolvedValueOnce(Response.json({ data: { onetimeProducts: [{ id: 'PROD_once', storeId: 'STO_wrong', status: 'active', prices: [] }] } }));
    await expect(client.readOneTimeProduct('PROD_once')).rejects.toThrow('OPERATION_SCOPE');
  });
  it('looks for all original payment refunds, paginates completely, and never retries refund dispatch', async () => {
    const refund = { id: 'RFD_one', paymentId: 'PAY_fixture1', ticketId: 'TKT_one', status: 'succeeded', testMode: true,
      amount: { amount: '100', currency: 'USD' }, pspAmountDetails: { amount: '1.00', currency: 'USD' },
      orderMerchantExternalId: 'order-1', refundTicketMerchantExternalId: 'ref-fixture1', createdAt: '2026-10-21T00:00:00.000Z' };
    const request = vi.fn().mockResolvedValueOnce(Response.json({ data: { refunds: Array.from({ length: 100 }, () => refund) } }))
      .mockResolvedValueOnce(Response.json({ data: { refunds: [] } }));
    const client = createWaffoTestOperationsClient(config, request);
    expect(await client.findRefunds({ paymentId: 'PAY_fixture1' })).toHaveLength(100);
    expect(JSON.parse(request.mock.calls[0]![1].body).query).not.toContain('refundTicketMerchantExternalId: { eq:');
    expect(JSON.parse(request.mock.calls[1]![1].body).query).toContain('offset: 100');
    request.mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError'));
    await expect(client.createRefundTicket({ paymentId: 'PAY_fixture1', reason: 'refund', requestedAmount: { amount: '1.00', currency: 'USD' },
      refundTicketMerchantExternalId: 'ref-fixture1' })).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('fails closed when a refund/ticket query is still full at its scan cap', async () => {
    const ticket = { id: 'TKT_one', subjectId: 'PAY_fixture1', status: 'processing', refundTicketMerchantExternalId: 'ref-fixture1' };
    const request = vi.fn().mockImplementation(async () => Response.json({ data: { refundTickets: Array.from({ length: 100 }, () => ticket) } }));
    const client = createWaffoTestOperationsClient(config, request);
    await expect(client.findRefundTickets('ref-fixture1')).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(request).toHaveBeenCalledTimes(20);
  });
  it('does not infer no dispute when the authoritative chargeback query fails', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ data: { chargebacks: [] } }))
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'unavailable' }] }));
    const client = createWaffoOperationsClient({ ...config, mode: 'live' }, request);
    expect(await client.hasChargeback('PAY_fixture1')).toBe(false);
    expect(JSON.parse(request.mock.calls[0]![1].body).variables).toEqual({ payment: 'PAY_fixture1', store: 'STO_fixture', test: false });
    await expect(client.hasChargeback('PAY_fixture1')).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
  it('propagates a shared deadline to every HTTP request and refuses dispatch after it expires', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const request = vi.fn().mockResolvedValue(Response.json({ data: { chargebacks: [] } }));
    const client = createWaffoOperationsClient({ ...config, mode: 'test', deadline: Date.now() + 500 }, request);
    await client.hasChargeback('PAY_fixture1');
    expect(timeout.mock.calls.at(-1)![0]).toBeGreaterThan(0);
    expect(timeout.mock.calls.at(-1)![0]).toBeLessThanOrEqual(500);
    const expired = createWaffoOperationsClient({ ...config, mode: 'test', deadline: Date.now() - 1 }, request);
    await expect(expired.hasChargeback('PAY_fixture1')).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(request).toHaveBeenCalledTimes(1);
    timeout.mockRestore();
  });
  it('preserves a strongly scoped chargeback with unknown money, and rejects foreign scope', async () => {
    const row = { id: 'CBK_real', paymentId: 'PAY_fixture1', storeId: 'STO_fixture', orderId: null,
      status: 'open', testMode: true, amount: null, createdAt: '2026-10-21T00:00:00.000Z' };
    const request = vi.fn().mockResolvedValueOnce(Response.json({ data: { chargebacks: [row] } }))
      .mockResolvedValueOnce(Response.json({ data: { chargebacks: [{ ...row, storeId: 'STO_wrong' }] } }));
    const client = createWaffoTestOperationsClient(config, request);
    expect(await client.readChargebacks('PAY_fixture1')).toEqual([row]);
    await expect(client.readChargebacks('PAY_fixture1')).rejects.toThrow('OPERATION_SCOPE');
  });
  it('does not load a provider binding until explicitly enabled in test configuration', () => {
    vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'false');
    expect(getWaffoTestOperationsClient).toThrow('TEST_CONFIG_UNAVAILABLE');
  });
});
