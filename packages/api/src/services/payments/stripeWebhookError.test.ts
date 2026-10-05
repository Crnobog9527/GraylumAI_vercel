/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { PAYMENT_EVIDENCE_CONFLICT, stripeWebhookErrorCode } from './stripeWebhookError';

describe('Stripe webhook error classification', () => {
  it.each(['PAY_COMMON_RECEIPT_MISMATCH', 'PAY_COMMON_INVOICE_RECEIPT_MISMATCH',
    'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH', 'PAY_COMMON_SUBSCRIPTION_OWNER_MISMATCH',
    'PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH', 'upgrade_invoice_quote_mismatch'])(
    'retains the fixed alarm code through wrapped validation failure %s', (message) => {
      expect(stripeWebhookErrorCode(new Error('safe wrapper', { cause: { code: 'P0001', message } })))
        .toBe(PAYMENT_EVIDENCE_CONFLICT);
    },
  );
  it.each(['ECONNRESET', 'ETIMEDOUT', 'PAY_COMMON_MAPPING_READ_FAILED', 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING',
    'PAY_COMMON_CHECKOUT_WRITE_FAILED', 'invalid signature', 'network message containing PAY_COMMON_RECEIPT_MISMATCH'])(
    'does not classify operational failure %s as an evidence conflict', (message) => {
      expect(stripeWebhookErrorCode(new Error(message))).toBe('PAY_COMMON_WEBHOOK_HANDLER_FAILED');
    },
  );
  it('bounds cyclic cause chains', () => {
    const error: { cause?: unknown } = {}; error.cause = error;
    expect(stripeWebhookErrorCode(error)).toBe('PAY_COMMON_WEBHOOK_HANDLER_FAILED');
  });
});
