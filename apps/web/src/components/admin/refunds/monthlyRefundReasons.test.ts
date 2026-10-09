/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { INELIGIBLE_REFUND_CODES, monthlyRefundQuoteRefusal } from './monthlyRefundReasons';

const FALLBACK = '通用说明';

it('maps rule failures as ineligible and evidence problems as needing a check', () => {
  expect(monthlyRefundQuoteRefusal(new Error('PAY_REFUND_OUTSIDE_WINDOW'), FALLBACK))
    .toEqual({ text: '已超过付款后 7 天的退款期限', specific: true, ineligible: true });
  expect(monthlyRefundQuoteRefusal(new Error('PAY_REFUND_RENEWAL'), FALLBACK).ineligible).toBe(true);
  expect(monthlyRefundQuoteRefusal(new Error('PAY_REFUND_EVIDENCE_INCOMPLETE'), FALLBACK))
    .toEqual({ text: '退款需要的证据不完整', specific: true, ineligible: false });
});

it('falls back to the generic text for unknown codes, server text and non-errors', () => {
  for (const cause of [new Error('PAY_REFUND_QUOTE_UNAVAILABLE'), new Error('toString'), new Error('任意服务器文字'), null, 'x']) {
    expect(monthlyRefundQuoteRefusal(cause, FALLBACK)).toEqual({ text: FALLBACK, specific: false, ineligible: false });
  }
});

it('suggests rejecting only for codes that mean one definite failed rule', () => {
  expect(INELIGIBLE_REFUND_CODES).toEqual([
    'PAY_REFUND_CREDITS_CONSUMED', 'PAY_REFUND_NOT_FIRST_PURCHASE', 'PAY_REFUND_OUTSIDE_WINDOW',
    'PAY_REFUND_PRIOR_REFUND_OR_DISPUTE', 'PAY_REFUND_RENEWAL',
  ]);
  // 0193 raises PAY_REFUND_WINDOW also for missing, future or changed times: check first, never reject outright.
  expect(monthlyRefundQuoteRefusal(new Error('PAY_REFUND_WINDOW'), FALLBACK)).toMatchObject({ specific: true, ineligible: false });
  expect(monthlyRefundQuoteRefusal(new Error('PAY_REFUND_MONTHLY_SCOPE_REQUIRED'), FALLBACK).ineligible).toBe(false);
  expect(monthlyRefundQuoteRefusal(new Error('PAY_MONTHLY_SCOPE_OR_STATE'), FALLBACK).ineligible).toBe(false);
});
