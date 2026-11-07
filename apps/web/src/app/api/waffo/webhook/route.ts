/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServiceRoleSupabaseClient } from '@repo/api/src/services/stripe';
import { handleWaffoWebhookHttp } from '@repo/api/src/services/payments/waffoWebhookHttp';
import { processWaffoReceipt } from '@repo/api/src/services/payments/waffoPaymentDelivery';
import { getWaffoOperationsClient } from '@repo/api/src/services/payments/waffoTestOperationsClient';

import { paymentDeploymentMode, assertWaffoWebhookEnvironment } from '@repo/api/src/services/payments/methodCheckoutGate';
import { afterWaffoFulfillment } from '@repo/api/src/services/payments/failoverAfterFulfillment';
import { notifyOwner } from '@repo/api/src/services/ownerAlerts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleWaffoWebhookHttp(request, {
    database: createServiceRoleSupabaseClient,
    config: () => {
      try { assertWaffoWebhookEnvironment(); } catch { return null; }
      const mode = paymentDeploymentMode();
      const publicKey = mode === 'test' ? process.env.WAFFO_TEST_WEBHOOK_PUBLIC_KEY : process.env.WAFFO_WEBHOOK_PUBLIC_KEY;
      const storeId = mode === 'test' ? process.env.WAFFO_TEST_STORE_ID : process.env.WAFFO_STORE_ID;
      const merchantNamespace = mode === 'test' ? process.env.WAFFO_TEST_MERCHANT_NAMESPACE : process.env.WAFFO_MERCHANT_NAMESPACE;
      return publicKey && storeId && merchantNamespace ? { publicKey, storeId, merchantNamespace, mode } : null;
    },
    process: receipt => {
      const db = createServiceRoleSupabaseClient();
      return processWaffoReceipt(db, getWaffoOperationsClient(receipt.mode),
        { id: receipt.receiptId, merchant: receipt.merchant, mode: receipt.mode, refs: receipt.refs },
        orderId => afterWaffoFulfillment(db, orderId));
    },
    // ALERT-FEISHU: Waffo redelivers; the Owner hears once per receipt, and at most hourly while callbacks cannot be stored.
    onFailure: failure => failure.stage === 'processing'
      ? notifyOwner('payment_webhook_failed', { provider: 'waffo', eventId: failure.receiptId, eventType: null, code: 'WAFFO_PROCESSING_DEFERRED' })
      : notifyOwner('payment_webhook_unavailable', { provider: 'waffo', reason: 'storage' }),
  });
}
