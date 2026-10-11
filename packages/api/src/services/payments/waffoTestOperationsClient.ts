/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createSign } from 'node:crypto';
import { z } from 'zod';
import type { WaffoTestOperations } from './waffoOperations';
import { WAFFO_PAYMENT_FIELDS, waffoPaymentSchema, type WaffoTestPayments } from './waffoPayments';

export type WaffoCheckoutCreate = {
  /** Same key replays the original session (measured, #802); the key never changes for one order. */
  createCheckout: (request: Record<string, unknown>, idempotencyKey: string) => Promise<unknown>;
};
export type WaffoTestClient = WaffoTestOperations & WaffoTestPayments & WaffoCheckoutCreate;
const PAGE = 100;

/** Pancake API-key signing, with no automatic retries. API key determines environment;
 * X-Environment cannot turn a production key into a test key. Only an Owner-configured,
 * explicitly enabled test binding may instantiate this client. */
export function createWaffoTestOperationsClient(config: {
  merchant: string; merchantId: string; storeId: string; privateKey: string;
}, request: typeof fetch = fetch): WaffoTestClient {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.merchant) || !/^MER_[A-Za-z0-9]+$/.test(config.merchantId)
    || !/^STO_[A-Za-z0-9]+$/.test(config.storeId)) throw new Error('PAY_WAFFO_TEST_CONFIG_INVALID');
  async function post(path: string, data: unknown, idempotencyKey?: string) {
    const body = JSON.stringify(data);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const digest = createHash('sha256').update(body).digest('base64');
    const signature = createSign('RSA-SHA256').update(`POST\n${path}\n${timestamp}\n${digest}`).sign(config.privateKey, 'base64');
    const response = await request(`https://api.waffo.ai${path}`, { method: 'POST', body, redirect: 'error',
      signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json',
        'X-Merchant-Id': config.merchantId, 'X-Timestamp': timestamp, 'X-Signature': signature,
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}) } });
    // A definitive 4xx creates nothing and does not occupy the idempotency key; timeouts, conflicts
    // (request still in flight), rate limits and 5xx stay unknown.
    if (response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status)) {
      throw new Error('PAY_WAFFO_PROVIDER_REJECTED');
    }
    if (!response.ok) throw new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE');
    const result = await response.json();
    if (!result || typeof result !== 'object' || result.errors?.length || !result.data) throw new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE');
    return result.data;
  }
  const subscription = z.object({ id: z.string(), status: z.string() });
  const product = z.object({ id: z.string(), status: z.enum(['active', 'inactive']) });
  return {
    merchant: config.merchant, mode: 'test', storeId: config.storeId,
    // Order identity comes from the standalone subscriptionOrders query only. Measured (#802):
    // nested payment.subscriptionOrder.metadata is null while this path returns metadata as a JSON
    // string, so a nested null must never be read as "no site order" or substituted.
    async readSubscription(orderId) {
      const data = await post('/v1/graphql', { query: `query($storeId: String!, $id: String!) {
        subscriptionOrders(storeId: $storeId, filter: { id: { eq: $id } }) { id status }
      }`, variables: { storeId: config.storeId, id: orderId } });
      const rows = z.array(subscription).length(1).parse(data.subscriptionOrders);
      if (rows[0]!.id !== orderId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      return { orderId, status: rows[0]!.status };
    },
    async cancelSubscription(orderId) {
      return z.object({ orderId: z.string(), status: z.string() }).parse(
        await post('/v1/actions/subscription-order/cancel-order', { orderId }));
    },
    async readProduct(id) {
      // Shapes measured against the test store (#802 evidence): the schema has no `ID` scalar, and
      // products are read through the top-level store-scoped list, not a nested Store field.
      const data = await post('/v1/graphql', { query: `query($storeId: String!, $id: String!) {
        store(id: $storeId) { id }
        subscriptionProducts(storeId: $storeId, filter: { id: { in: [$id] } }, limit: 2, offset: 0) { id status }
      }`, variables: { storeId: config.storeId, id } });
      const store = z.object({ id: z.string() }).parse(data.store);
      if (store.id !== config.storeId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      const rows = z.array(product).parse(data.subscriptionProducts).filter(row => row.id === id);
      if (rows.length !== 1) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      return rows[0]!;
    },
    async readPayment(paymentId) {
      const data = await post('/v1/graphql', { query: `query($id: String!) { payment(id: $id) { ${WAFFO_PAYMENT_FIELDS} } }`,
        variables: { id: paymentId } });
      if (data.payment === null) return null;
      const payment = waffoPaymentSchema.parse(data.payment);
      if (payment.id !== paymentId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      return payment;
    },
    async listPayments(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      // Literal limit/offset is the measured shape; offset is a validated non-negative integer.
      const data = await post('/v1/graphql', { query: `query($storeId: String!) {
        payments(filter: { storeId: { eq: $storeId } }, limit: ${PAGE}, offset: ${offset}) { ${WAFFO_PAYMENT_FIELDS} }
      }`, variables: { storeId: config.storeId } });
      const rows = z.array(waffoPaymentSchema).max(PAGE).parse(data.payments);
      return { rows, complete: rows.length < PAGE };
    },
    async createCheckout(body, idempotencyKey) {
      if (!/^[A-Za-z0-9_:-]{8,128}$/.test(idempotencyKey)) throw new Error('PAY_WAFFO_CHECKOUT_INVALID');
      return post('/v1/actions/checkout/create-session', body, idempotencyKey);
    },
    async setProductStatus(id, status) {
      const data = await post('/v1/actions/subscription-product/update-status', { id, status });
      return product.parse(data.product);
    },
  };
}

export function getWaffoTestOperationsClient() {
  // Separate from new-sale switches: historical cancellation remains available while sales are off.
  // This flag is not changed by the implementation and defaults to closed.
  if (process.env.WAFFO_TEST_OPERATIONS_ENABLED !== 'true') throw new Error('PAY_WAFFO_TEST_CONFIG_UNAVAILABLE');
  const merchant = process.env.WAFFO_TEST_MERCHANT_NAMESPACE;
  const merchantId = process.env.WAFFO_TEST_MERCHANT_ID;
  const storeId = process.env.WAFFO_TEST_STORE_ID;
  const privateKey = process.env.WAFFO_TEST_PRIVATE_KEY;
  if (!merchant || !merchantId || !storeId || !privateKey) throw new Error('PAY_WAFFO_TEST_CONFIG_UNAVAILABLE');
  return createWaffoTestOperationsClient({ merchant, merchantId, storeId, privateKey });
}
