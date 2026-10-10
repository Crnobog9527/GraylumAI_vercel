/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createSign } from 'node:crypto';
import { z } from 'zod';
import type { WaffoTestOperations } from './waffoOperations';

/** Pancake API-key signing, with no automatic retries. API key determines environment;
 * X-Environment cannot turn a production key into a test key. Only an Owner-configured,
 * explicitly enabled test binding may instantiate this client. */
export function createWaffoTestOperationsClient(config: {
  merchant: string; merchantId: string; storeId: string; privateKey: string;
}, request: typeof fetch = fetch): WaffoTestOperations {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.merchant) || !/^MER_[A-Za-z0-9]+$/.test(config.merchantId)
    || !/^STO_[A-Za-z0-9]+$/.test(config.storeId)) throw new Error('PAY_WAFFO_TEST_CONFIG_INVALID');
  async function post(path: string, data: unknown) {
    const body = JSON.stringify(data);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const digest = createHash('sha256').update(body).digest('base64');
    const signature = createSign('RSA-SHA256').update(`POST\n${path}\n${timestamp}\n${digest}`).sign(config.privateKey, 'base64');
    const response = await request(`https://api.waffo.ai${path}`, { method: 'POST', body, redirect: 'error',
      signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json',
        'X-Merchant-Id': config.merchantId, 'X-Timestamp': timestamp, 'X-Signature': signature } });
    if (!response.ok) throw new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE');
    const result = await response.json();
    if (!result || typeof result !== 'object' || result.errors?.length || !result.data) throw new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE');
    return result.data;
  }
  const subscription = z.object({ id: z.string(), status: z.string() });
  const product = z.object({ id: z.string(), status: z.enum(['active', 'inactive']) });
  return {
    merchant: config.merchant, mode: 'test',
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
      const data = await post('/v1/graphql', { query: `query($storeId: ID!) {
        store(id: $storeId) { id subscriptionProducts { id status } }
      }`, variables: { storeId: config.storeId } });
      const store = z.object({ id: z.string(), subscriptionProducts: z.array(product) }).parse(data.store);
      if (store.id !== config.storeId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      const rows = store.subscriptionProducts.filter(row => row.id === id);
      if (rows.length !== 1) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      return rows[0]!;
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
