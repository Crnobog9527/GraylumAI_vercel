/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { monthlyRefundQuoteRefusal } from './monthlyRefundReasons';

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
