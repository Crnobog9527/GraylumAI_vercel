/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServiceRoleSupabaseClient } from '@repo/api/src/services/stripe';
import { handleWaffoWebhookHttp } from '@repo/api/src/services/payments/waffoWebhookHttp';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleWaffoWebhookHttp(request, {
    database: createServiceRoleSupabaseClient,
    config: () => {
      const publicKey = process.env.WAFFO_TEST_WEBHOOK_PUBLIC_KEY;
      const storeId = process.env.WAFFO_TEST_STORE_ID;
      const merchantNamespace = process.env.WAFFO_TEST_MERCHANT_NAMESPACE;
      return publicKey && storeId && merchantNamespace ? { publicKey, storeId, merchantNamespace } : null;
    },
  });
}
