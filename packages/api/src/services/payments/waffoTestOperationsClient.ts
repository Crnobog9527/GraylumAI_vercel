/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createSign } from 'node:crypto';
import { z } from 'zod';
import type { WaffoTestOperations } from './waffoOperations';
import { normalizeWaffoPrivateKey, providerNotices, WaffoFailure, type WaffoFailureCategory } from './waffoFailure';
import { WAFFO_PAYMENT_FIELDS, waffoPaymentSchema, type WaffoTestPayments } from './waffoPayments';

export type WaffoCheckoutCreate = {
  /** Correlation key only; Waffo does not guarantee checkout idempotency (2026-10-12). */
  createCheckout: (request: Record<string, unknown>, idempotencyKey: string) => Promise<unknown>;
};
export type WaffoTestClient = WaffoTestOperations & WaffoTestPayments & WaffoCheckoutCreate;
const PAGE = 100;
const CHECKOUT_TIMEOUT_MS = 20_000;

/** Pancake API-key signing, with no automatic retries. API key determines environment;
 * X-Environment cannot turn a production key into a test key. Only an Owner-configured,
 * server-selected binding may instantiate this client. Test operations remain separately enabled. */
export type WaffoRefund = { id: string; paymentId: string; ticketId: string | null; status: string; testMode: boolean;
  amount: { amount: string; currency: string }; pspAmountDetails: { amount: string; currency: string };
  orderMerchantExternalId: string | null; refundTicketMerchantExternalId: string | null; createdAt: string };
export type WaffoRefundTicket = { id: string; subjectId: string; status: string; refundTicketMerchantExternalId: string | null };
export type WaffoChargeback = { id: string; paymentId: string | null; storeId: string; orderId: string | null;
  status: string; testMode: boolean; amount: { amount: string | null; currency: string | null } | null; createdAt: string;
  /** Waffo's response deadline ("Expire Date"); only the store-wide list reads it. */
  expiryDateTime?: string | null };
export type WaffoOneTimeOrder = { id: string; storeId: string; status: string; testMode: boolean; orderMerchantExternalId: string | null };
export type WaffoOperationsClient = Omit<WaffoTestClient, 'mode'> & { mode: 'test' | 'live';
  findOneTimeOrders: (orderId: string, deadline?: number) => Promise<WaffoOneTimeOrder[]>;
  findOrderPayments: (orderId: string, deadline?: number) => Promise<import('./waffoPayments').WaffoPayment[]>;
  readOneTimeProduct: (id: string) => Promise<{ id: string; status: string; storeId: string;
    prices: { currency: string; priceInfo: { amount: string; taxCategory: string } }[] }>;
  createRefundTicket: (input: { paymentId: string; reason: string; requestedAmount: { amount: string; currency: 'USD' };
    refundTicketMerchantExternalId: string }) => Promise<WaffoRefundTicket>;
  findRefundTickets: (reference: string) => Promise<WaffoRefundTicket[]>;
  hasChargeback: (paymentId: string) => Promise<boolean>;
  readChargebacks: (paymentId: string, deadline?: number) => Promise<WaffoChargeback[]>;
  listChargebacks: (deadline?: number) => Promise<WaffoChargeback[]>;
  findRefunds: (input: { paymentId: string; reference?: string }) => Promise<WaffoRefund[]>;
};
export function createWaffoOperationsClient(config: {
  merchant: string; merchantId: string; storeId: string; privateKey: string; mode: 'test' | 'live'; deadline?: number;
}, request: typeof fetch = fetch): WaffoOperationsClient {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.merchant) || !/^MER_[A-Za-z0-9]+$/.test(config.merchantId)
    || !/^STO_[A-Za-z0-9]+$/.test(config.storeId)) throw new Error('PAY_WAFFO_TEST_CONFIG_INVALID');
  // Parsed once, before any order or provider access, so a bad dashboard paste is reported as
  // configuration rather than surfacing later as an unknown checkout outcome.
  const privateKey = normalizeWaffoPrivateKey(config.privateKey);
  async function post(path: string, data: unknown, idempotencyKey?: string, timeoutMs = 8000) {
    const remaining = config.deadline === undefined ? timeoutMs : Math.floor(config.deadline - Date.now());
    if (remaining <= 0) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    const requestTimeout = Math.min(timeoutMs, remaining);
    const body = JSON.stringify(data);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const digest = createHash('sha256').update(body).digest('base64');
    const signature = createSign('RSA-SHA256').update(`POST\n${path}\n${timestamp}\n${digest}`).sign(privateKey, 'base64');
    let response: Response;
    try {
      response = await request(`https://api.waffo.ai${path}`, { method: 'POST', body, redirect: 'error',
        signal: AbortSignal.timeout(requestTimeout), headers: { 'Content-Type': 'application/json',
          'X-Merchant-Id': config.merchantId, 'X-Timestamp': timestamp, 'X-Signature': signature,
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}) } });
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      throw new WaffoFailure('PAY_WAFFO_PROVIDER_UNAVAILABLE', { category: name === 'TimeoutError' ? 'timeout' : 'network',
        path, errorName: name, ...(typeof cause === 'string' ? { errorCode: cause.slice(0, 40) } : {}) });
    }
    const envelope = await response.json().catch(() => undefined);
    const fail = (message: string, category: WaffoFailureCategory) => new WaffoFailure(message, { category, path,
      httpStatus: response.status, providerErrors: providerNotices(envelope) });
    // A definitive 4xx creates nothing and does not occupy the idempotency key; timeouts, conflicts
    // (request still in flight), rate limits and 5xx stay unknown.
    if (response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status)) {
      throw fail('PAY_WAFFO_PROVIDER_REJECTED', 'http_status');
    }
    if (!response.ok) throw fail('PAY_WAFFO_PROVIDER_UNAVAILABLE', 'http_status');
    if (!envelope || typeof envelope !== 'object') throw fail('PAY_WAFFO_PROVIDER_UNAVAILABLE', 'non_json');
    if (envelope.errors?.length) throw fail('PAY_WAFFO_PROVIDER_UNAVAILABLE', 'provider_errors');
    if (!envelope.data) throw fail('PAY_WAFFO_PROVIDER_UNAVAILABLE', 'empty_data');
    return envelope.data;
  }
  const subscription = z.object({ id: z.string(), status: z.string() });
  const product = z.object({ id: z.string(), status: z.enum(['active', 'inactive']) });
  return {
    merchant: config.merchant, mode: config.mode, storeId: config.storeId,
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
    async findOneTimeOrders(orderId, deadline = Date.now() + 20_000) {
      if (!z.uuid().safeParse(orderId).success) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      const rows: WaffoOneTimeOrder[] = [];
      for (let offset = 0; offset < 2000; offset += PAGE) {
        if (Date.now() >= deadline) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
        const data = await post('/v1/graphql', { query: `query($store: String!, $ref: String!) {
          onetimeOrders(storeId: $store, filter: { orderMerchantExternalId: { eq: $ref } }, limit: ${PAGE}, offset: ${offset}) {
            id storeId status testMode orderMerchantExternalId }
        }`, variables: { store: config.storeId, ref: orderId } });
        const page = z.array(oneTimeOrderSchema).max(PAGE).parse(data.onetimeOrders);
        if (page.some(row => row.storeId !== config.storeId || row.testMode !== (config.mode === 'test')
          || row.orderMerchantExternalId !== orderId)) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
      throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    },
    async findOrderPayments(orderId, deadline = Date.now() + 20_000) {
      if (!z.uuid().safeParse(orderId).success) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      const rows: import('./waffoPayments').WaffoPayment[] = [];
      for (let offset = 0; offset < 2000; offset += PAGE) {
        if (Date.now() >= deadline) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
        const data = await post('/v1/graphql', { query: `query($store: String!, $ref: String!) {
          payments(filter: { storeId: { eq: $store }, orderMerchantExternalId: { eq: $ref } },
            limit: ${PAGE}, offset: ${offset}) { ${WAFFO_PAYMENT_FIELDS} }
        }`, variables: { store: config.storeId, ref: orderId } });
        const page = z.array(waffoPaymentSchema).max(PAGE).parse(data.payments);
        if (page.some(row => row.testMode !== (config.mode === 'test') || row.orderMerchantExternalId !== orderId)) {
          throw new Error('PAY_WAFFO_OPERATION_SCOPE');
        }
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
      throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    },
    async readOneTimeProduct(id) {
      const data = await post('/v1/graphql', { query: `query($storeId: String!, $id: String!) {
        onetimeProducts(storeId: $storeId, filter: { id: { in: [$id] } }, limit: 2, offset: 0) {
          id storeId status prices { currency priceInfo { amount taxCategory } } }
      }`, variables: { storeId: config.storeId, id } });
      const rows = z.array(z.object({ id: z.string(), storeId: z.string(), status: z.string(),
        prices: z.array(z.object({ currency: z.string(), priceInfo: z.object({ amount: z.string(), taxCategory: z.string() }) })),
      })).length(1).parse(data.onetimeProducts);
      if (rows[0]!.id !== id || rows[0]!.storeId !== config.storeId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      return rows[0]!;
    },
    async readChargebacks(paymentId, deadline = Date.now() + 20_000) {
      if (!/^PAY_[A-Za-z0-9]+$/.test(paymentId)) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
      const rows: WaffoChargeback[] = [];
      for (let offset = 0; offset < 2000; offset += PAGE) {
        if (Date.now() >= deadline) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
        const data = await post('/v1/graphql', { query: `query($payment: String!, $store: String!, $test: Boolean!) {
          chargebacks(filter: { paymentId: { eq: $payment }, storeId: { eq: $store }, testMode: { eq: $test } },
            limit: ${PAGE}, offset: ${offset}) { id paymentId storeId orderId status testMode amount { amount currency } createdAt }
        }`, variables: { payment: paymentId, store: config.storeId, test: config.mode === 'test' } });
        const page = z.array(chargebackSchema).max(PAGE).parse(data.chargebacks);
        if (page.some(row => row.paymentId !== paymentId || row.storeId !== config.storeId || row.testMode !== (config.mode === 'test'))) {
          throw new Error('PAY_WAFFO_OPERATION_SCOPE');
        }
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
      throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    },
    // Waffo sends no chargeback webhook (2026-10-10 answer): the daily job reads this store's whole list.
    async listChargebacks(deadline = Date.now() + 20_000) {
      const rows: WaffoChargeback[] = [];
      for (let offset = 0; offset < 2000; offset += PAGE) {
        if (Date.now() >= deadline) throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
        const data = await post('/v1/graphql', { query: `query($store: String!, $test: Boolean!) {
          chargebacks(filter: { storeId: { eq: $store }, testMode: { eq: $test } }, limit: ${PAGE}, offset: ${offset}) {
            id paymentId storeId orderId status testMode amount { amount currency } createdAt expiryDateTime }
        }`, variables: { store: config.storeId, test: config.mode === 'test' } });
        const page = z.array(chargebackSchema).max(PAGE).parse(data.chargebacks);
        if (page.some(row => row.storeId !== config.storeId || row.testMode !== (config.mode === 'test'))) {
          throw new Error('PAY_WAFFO_OPERATION_SCOPE');
        }
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
      throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    },
    async hasChargeback(paymentId) {
      if (!/^PAY_[A-Za-z0-9]+$/.test(paymentId)) throw new Error('PAY_WAFFO_REFUND_INVALID');
      const data = await post('/v1/graphql', { query: `query($payment: String!, $store: String!, $test: Boolean!) {
        chargebacks(filter: { paymentId: { eq: $payment }, storeId: { eq: $store }, testMode: { eq: $test } }, limit: 1) { id }
      }`, variables: { payment: paymentId, store: config.storeId, test: config.mode === 'test' } });
      return z.array(z.object({ id: z.string() })).max(1).parse(data.chargebacks).length !== 0;
    },
    async createRefundTicket(input) {
      if (!/^PAY_[A-Za-z0-9]+$/.test(input.paymentId) || !/^[0-9]+\.[0-9]{2}$/.test(input.requestedAmount.amount)
        || Number(input.requestedAmount.amount) <= 0 || input.requestedAmount.currency !== 'USD'
        || !/^[A-Za-z0-9_:-]{8,128}$/.test(input.refundTicketMerchantExternalId)
        || !input.reason || input.reason.length > 500) throw new Error('PAY_WAFFO_REFUND_INVALID');
      const data = await post('/v1/actions/refund-ticket/create-ticket', input);
      return refundTicketSchema.parse(data.ticket);
    },
    async findRefundTickets(reference) {
      if (!/^[A-Za-z0-9_:-]{8,128}$/.test(reference)) throw new Error('PAY_WAFFO_REFUND_INVALID');
      const rows: WaffoRefundTicket[] = [];
      for (let offset = 0; offset < 2000; offset += PAGE) {
        const data = await post('/v1/graphql', { query: `query($ref: String!) {
          refundTickets(filter: { refundTicketMerchantExternalId: { eq: $ref } }, limit: ${PAGE}, offset: ${offset}) {
            id subjectId status refundTicketMerchantExternalId }
        }`, variables: { ref: reference } });
        const page = z.array(refundTicketSchema).max(PAGE).parse(data.refundTickets);
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
      throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
    },
    async findRefunds(input) {
      if (!/^PAY_[A-Za-z0-9]+$/.test(input.paymentId)
        || (input.reference !== undefined && !/^[A-Za-z0-9_:-]{8,128}$/.test(input.reference))) {
        throw new Error('PAY_WAFFO_REFUND_INVALID');
      }
      const rows: WaffoRefund[] = [];
      for (let offset = 0; offset < 2000; offset += PAGE) {
        const data = await post('/v1/graphql', { query: `query($payment: String!${input.reference ? ', $ref: String!' : ''}) {
          refunds(filter: { ${input.reference ? 'refundTicketMerchantExternalId: { eq: $ref },' : ''}
            paymentId: { eq: $payment } }, limit: ${PAGE}, offset: ${offset}) {
            id paymentId ticketId status testMode amount { amount currency } pspAmountDetails { amount currency }
            orderMerchantExternalId refundTicketMerchantExternalId createdAt }
        }`, variables: { ...(input.reference ? { ref: input.reference } : {}), payment: input.paymentId } });
        const page = z.array(refundSchema).max(PAGE).parse(data.refunds);
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
      throw new Error('PAY_WAFFO_RECONCILIATION_REQUIRED');
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
      // Longer than reads: the buyer is waiting anyway, and a timed-out create leaves the order to the
      // same-key replay instead of opening checkout.
      return post('/v1/actions/checkout/create-session', body, idempotencyKey, CHECKOUT_TIMEOUT_MS);
    },
    async setProductStatus(id, status) {
      const data = await post('/v1/actions/subscription-product/update-status', { id, status });
      return product.parse(data.product);
    },
  };
}

const refundTicketSchema = z.object({ id: z.string(), subjectId: z.string(), status: z.string(),
  refundTicketMerchantExternalId: z.string().nullable() });
const moneySchema = z.object({ amount: z.string(), currency: z.string() });
const refundSchema = z.object({ id: z.string(), paymentId: z.string(), ticketId: z.string().nullable(), status: z.string(),
  testMode: z.boolean(), amount: moneySchema, pspAmountDetails: moneySchema, orderMerchantExternalId: z.string().nullable(),
  refundTicketMerchantExternalId: z.string().nullable(), createdAt: z.string().datetime() });

const oneTimeOrderSchema = z.object({ id: z.string(), storeId: z.string(), status: z.string(), testMode: z.boolean(),
  orderMerchantExternalId: z.string().nullable() });
const chargebackSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/), paymentId: z.string().nullable(), storeId: z.string(),
  orderId: z.string().nullable(), status: z.string(), testMode: z.boolean(),
  amount: z.object({ amount: z.string().nullish().transform(value => value ?? null),
    currency: z.string().nullish().transform(value => value ?? null) }).nullish().transform(value => value ?? null),
  createdAt: z.string().datetime(), expiryDateTime: z.string().nullish() });

export function createWaffoTestOperationsClient(config: {
  merchant: string; merchantId: string; storeId: string; privateKey: string; deadline?: number;
}, request: typeof fetch = fetch): WaffoOperationsClient & { mode: 'test' } {
  return createWaffoOperationsClient({ ...config, mode: 'test' }, request) as WaffoOperationsClient & { mode: 'test' };
}

export function getWaffoOperationsClient(mode: 'test' | 'live', options?: { deadline: number }): WaffoOperationsClient {
  if (mode === 'test') return getWaffoTestOperationsClient(options);
  // The server chooses live from its deployment binding, never an untrusted webhook body.
  const merchant = process.env.WAFFO_MERCHANT_NAMESPACE;
  const merchantId = process.env.WAFFO_MERCHANT_ID;
  const storeId = process.env.WAFFO_STORE_ID;
  const privateKey = process.env.WAFFO_PRIVATE_KEY;
  if (!merchant || !merchantId || !storeId || !privateKey) throw new Error('PAY_WAFFO_CONFIG_UNAVAILABLE');
  return createWaffoOperationsClient({ merchant, merchantId, storeId, privateKey, mode, ...options });
}

export function getWaffoTestOperationsClient(options?: { deadline: number }) {
  // Separate from new-sale switches: historical cancellation remains available while sales are off.
  // This flag is not changed by the implementation and defaults to closed.
  if (process.env.WAFFO_TEST_OPERATIONS_ENABLED !== 'true') throw new Error('PAY_WAFFO_TEST_CONFIG_UNAVAILABLE');
  const merchant = process.env.WAFFO_TEST_MERCHANT_NAMESPACE;
  const merchantId = process.env.WAFFO_TEST_MERCHANT_ID;
  const storeId = process.env.WAFFO_TEST_STORE_ID;
  const privateKey = process.env.WAFFO_TEST_PRIVATE_KEY;
  if (!merchant || !merchantId || !storeId || !privateKey) throw new Error('PAY_WAFFO_TEST_CONFIG_UNAVAILABLE');
  return createWaffoTestOperationsClient({ merchant, merchantId, storeId, privateKey, ...options });
}
